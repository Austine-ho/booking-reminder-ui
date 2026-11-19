window.GH_DEFAULTS = {"owner": "Austine-ho", "repo": "booking-reminder"};
"use strict";
/* GitHub 版後端轉接：把介面的 /api/... 呼叫轉成 GitHub API。
 * - 需求清單 watches.yaml、監控狀態 state.json 存在你的私人 repo
 * - 檢查由該 repo 的 GitHub Actions（monitor.yml）執行
 * - 金鑰加密後存進 GitHub Secrets，一般設定存在 GitHub Variables
 * - 登入資訊（repo 與 token）只存在這支手機/電腦的瀏覽器
 * GH_DEFAULTS 由 tools/build_ui.py 在檔案最前面注入。
 */
(() => {
  const LS_KEY = "br_github";
  const API = "https://api.github.com";
  const WORKFLOW = "monitor.yml";
  const JS_YAML = "https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js";
  const SODIUM = "https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.15/+esm";
  const DEFAULT_TIMES = { 1: ["09:30"], 2: ["09:30", "20:00"], 3: ["09:30", "13:00", "20:00"] };
  const SECRETS = { telegram_bot_token: "TELEGRAM_BOT_TOKEN", line_channel_access_token: "LINE_CHANNEL_ACCESS_TOKEN",
    groq_api_key: "GROQ_API_KEY", anthropic_api_key: "ANTHROPIC_API_KEY", gemini_api_key: "GEMINI_API_KEY", groq_api_key_2: "GROQ_API_KEY_2" };
  const VARS = { telegram_chat_id: "TELEGRAM_CHAT_ID", line_user_id: "LINE_USER_ID", ai_provider: "AI_PROVIDER",
    groq_model: "GROQ_MODEL", claude_model: "CLAUDE_MODEL", gemini_model: "GEMINI_MODEL", ai_max_per_site_day: "AI_MAX_PER_SITE_DAY",
    ai_max_per_day: "AI_MAX_PER_DAY", daily_summary: "DAILY_SUMMARY", daily_summary_time: "DAILY_SUMMARY_TIME" };
  const CHECK_TYPES = ["text_present", "text_absent", "selector_exists", "selector_absent", "selector_enabled",
    "date_present", "changed", "ai", "open_time", "booking_dates"];

  const conf = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; } })();
  if (!conf || !conf.token) { location.replace("login.html"); return; }
  const repoPath = `/repos/${conf.owner}/${conf.repo}`;

  // ---------------------------------------------------------------- 基本工具
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  async function gh(method, path, body) {
    const r = await fetch(API + path, {
      method, cache: "no-store",
      headers: {
        Authorization: `Bearer ${conf.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      localStorage.removeItem(LS_KEY);
      location.replace("login.html?expired=1");
      throw new HttpError(401, "GitHub token 失效，請重新登入");
    }
    if (r.status === 204) return null;
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      let msg = data.message || `GitHub 錯誤 ${r.status}`;
      if (r.status === 403 || r.status === 404) msg += "（請確認 token 有這個 repo 的 Contents / Actions / Secrets / Variables 權限）";
      if (r.status >= 500) msg = `GitHub 暫時無法連線（${r.status}），請稍後再試`;
      throw new HttpError(r.status, msg);
    }
    return data;
  }

  const loaded = {};
  function loadScript(src) {
    return (loaded[src] ||= new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error("無法載入 " + src));
      document.head.append(s);
    }));
  }

  const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  async function readFile(path) {
    try {
      const f = await gh("GET", `${repoPath}/contents/${path}`);
      return { text: b64decode(f.content), sha: f.sha };
    } catch (e) {
      if (e.status === 404) return { text: null, sha: null };
      throw e;
    }
  }
  async function writeFile(path, text, sha, message) {
    return gh("PUT", `${repoPath}/contents/${path}`, { message, content: b64encode(text), ...(sha ? { sha } : {}) });
  }

  async function loadYaml() {
    await loadScript(JS_YAML);
    const f = await readFile("watches.yaml");
    const data = (f.text && window.jsyaml.load(f.text)) || {};
    return { data: { requests: data.requests || [] }, sha: f.sha };
  }
  const dumpYaml = (data) => window.jsyaml.dump(data, { lineWidth: -1, noRefs: true, forceQuotes: true, quotingType: '"' });

  /** 讀 → 修改 → 寫回；和 GitHub Actions 同時寫入而衝突時自動重試 */
  async function mutate(path, fn, message) {
    for (let i = 0; i < 4; i++) {
      let obj, sha;
      if (path === "watches.yaml") ({ data: obj, sha } = await loadYaml());
      else { const f = await readFile(path); obj = f.text ? JSON.parse(f.text) : {}; sha = f.sha; }
      const result = fn(obj);
      const text = path === "watches.yaml" ? dumpYaml(obj) : JSON.stringify(obj, null, 2);
      try {
        await writeFile(path, text, sha, message);
        return result;
      } catch (e) {
        if (![409, 422].includes(e.status)) throw e;
        if (i === 3) throw new Error("資料正在被 GitHub Actions 更新，請過幾秒再試一次");
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  const mutateReqs = (fn, msg) => mutate("watches.yaml", (d) => fn(d.requests), msg);

  async function dispatch(inputs) {
    await gh("POST", `${repoPath}/actions/workflows/${WORKFLOW}/dispatches`, { ref: await defaultBranch(), inputs });
  }
  let _branch;
  async function defaultBranch() {
    return (_branch ||= (await gh("GET", repoPath)).default_branch);
  }

  // ---------------------------------------------------------------- 與 Python 版一致的規則
  function slugify(t) {
    return (t.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "item";
  }
  function uniqueId(base, taken) {
    let id = slugify(base), n = 2;
    while (taken.has(id)) id = `${slugify(base)}-${n++}`;
    return id;
  }
  const takenIds = (reqs) => new Set(reqs.flatMap((r) => [r.id, ...(r.watches || []).map((w) => w.id)]));

  function normalizeTimes(times) {
    const out = [...new Set((times || []).map((t) => t.trim()).filter(Boolean))].sort();
    if (!out.length) throw new Error("至少要有一個檢查時間");
    if (out.length > 6) throw new Error("每天最多 6 個檢查時間");
    for (const t of out) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`時間格式不正確：${t}`);
    return out;
  }

  /** 「某時區的當地時間」→ ISO 8601（含偏移） */
  function zonedToIso(local, tz) {
    if (!local) return "";
    const asUtc = new Date(local + ":00Z");
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(asUtc).map((x) => [x.type, x.value]));
    const offMin = Math.round((Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - asUtc) / 60000);
    const sign = offMin >= 0 ? "+" : "-";
    const a = Math.abs(offMin);
    return `${local}:00${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
  }

  // 開賣規則「入場日前 N 天」：依目標日期重算預計開放日期（時刻、時區沿用原設定；沒有就用 00:00）。與 config.py 的 apply_open_rule 相同
  function applyOpenRule(r, tz) {
    const n = Number(r.open_days_before) || 0;
    if (!(n > 0 && n <= 400)) { delete r.open_days_before; return; }
    r.open_days_before = n;
    if (!/^\d{4}-\d\d-\d\d$/.test(r.target_date || "")) return;
    const d = new Date(r.target_date + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - n);
    const day = d.toISOString().slice(0, 10);
    r.expected_open_at = /^\d{4}-\d\d-\d\dT/.test(r.expected_open_at || "")
      ? day + r.expected_open_at.slice(10) : zonedToIso(day + "T00:00", tz || "Asia/Taipei");
  }

  function makeWatch(wi, base, taken) {
    let u;
    try { u = new URL(wi.url); } catch { throw new Error(`網址格式不正確：${wi.url}`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`網址格式不正確：${wi.url}`);
    const host = u.hostname.split(".");
    const id = uniqueId(`${base}-${host.length > 1 ? host[host.length - 2] : u.hostname}`, taken);
    taken.add(id);
    const checks = (wi.checks || []).filter((c) => CHECK_TYPES.includes(c.type))
      .map((c) => (c.value ? { type: c.type, value: c.value } : { type: c.type }));
    return {
      id, name: wi.name || u.hostname, url: wi.url,
      checks: checks.length ? checks : [{ type: "ai" }],
      match: wi.match === "all" ? "all" : "any", render: !!wi.render,
      ...(wi.notes ? { notes: wi.notes } : {}), enabled: true,
    };
  }

  function watchStatus(w, st) {
    if (w.enabled === false) return "paused";
    if (st.status === "opened" || st.status === "expired") return st.status;
    if ((st.fails || 0) > 0) return "error";
    return st.last_check ? "watching" : "pending";
  }

  // ---------------------------------------------------------------- meta / settings 快取
  let metaCache = null;
  async function repoConfig() {
    const [secrets, vars] = await Promise.all([
      gh("GET", `${repoPath}/actions/secrets?per_page=100`).then((d) => new Set(d.secrets.map((s) => s.name))),
      gh("GET", `${repoPath}/actions/variables?per_page=100`).then((d) => Object.fromEntries(d.variables.map((v) => [v.name, v.value]))),
    ]);
    return { secrets, vars };
  }
  const PROVIDERS = ["groq", "claude", "gemini", "none"];
  const PROVIDER_KEYS = { groq: "GROQ_API_KEY", claude: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
  function providerOf(secrets, vars) {
    const p = (vars.AI_PROVIDER || "").toLowerCase();
    if (PROVIDERS.includes(p)) return p;
    for (const name of ["groq", "claude", "gemini"]) if (hasKey(secrets, name)) return name;
    return "none";
  }
  // Groq 可以有兩組（第二組為備用帳號）
  function hasKey(secrets, provider) {
    if (provider === "groq") return secrets.has("GROQ_API_KEY") || secrets.has("GROQ_API_KEY_2");
    return secrets.has(PROVIDER_KEYS[provider]);
  }
  // AI 查詢和判斷用同一家（Groq 用完時，Actions 端才會臨時改用 Gemini）
  function researchProviderOf(secrets, provider) {
    return hasKey(secrets, provider) ? provider : "none";
  }

  async function lastRunInfo() {
    try {
      const d = await gh("GET", `${repoPath}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
      const run = d.workflow_runs?.[0];
      if (!run) return "GitHub Actions 還沒有執行過（新增需求後，最晚 30 分鐘內會開始）";
      const t = new Date(run.updated_at);
      const when = `${t.getMonth() + 1}/${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      const res = run.status !== "completed" ? "⏳ 執行中" : run.conclusion === "success" ? "✅ 成功" : `⚠️ ${run.conclusion}`;
      return `GitHub Actions 上次執行：${when} ${res} · <a href="${run.html_url}" target="_blank" rel="noopener">查看紀錄</a>（每 30 分鐘喚醒一次，到了檢查時間才會真的檢查）`;
    } catch { return ""; }
  }

  // ---------------------------------------------------------------- 路由
  const routes = [];
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

  on("GET", "/api/meta", async () => {
    const { secrets, vars } = await repoConfig();
    const state = JSON.parse((await readFile("state.json")).text || "{}");
    const tz = vars.CHECK_TZ || "Asia/Taipei";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const usage = state._ai_usage?.date === today ? state._ai_usage : { total: 0, sites: {} };
    const provider = providerOf(secrets, vars);
    const channels = [];
    if (secrets.has("TELEGRAM_BOT_TOKEN") && vars.TELEGRAM_CHAT_ID) channels.push("telegram");
    if (secrets.has("LINE_CHANNEL_ACCESS_TOKEN") && vars.LINE_USER_ID) channels.push("line");
    const repoUrl = `https://github.com/${conf.owner}/${conf.repo}`;
    metaCache = {
      mode: "github", default_times: DEFAULT_TIMES, check_tz: tz, channels,
      ai_provider: provider,
      has_ai: hasKey(secrets, provider),
      research_provider: researchProviderOf(secrets, provider),
      ai_usage: usage, ai_limits: [+(vars.AI_MAX_PER_SITE_DAY || 6), +(vars.AI_MAX_PER_DAY || 30)],
      password_set: true,
      gh_html: `資料存在私人 repo：<a href="${repoUrl}" target="_blank" rel="noopener"><code>${conf.owner}/${conf.repo}</code></a><br>
        <span class="hint">檢查由 <a href="${repoUrl}/actions" target="_blank" rel="noopener">GitHub Actions</a> 執行，每 30 分鐘喚醒一次，
        到了你設定的檢查時間才會真的去看網站（GitHub 尖峰時段可能晚 10~30 分鐘）。
        登入用的 token 只存在這台裝置的瀏覽器；換手機時重新登入即可。按右上角「登出」會清除。</span>`,
    };
    return metaCache;
  });

  on("GET", "/api/requests", async () => {
    const [{ data }, stateFile, runInfo] = await Promise.all([loadYaml(), readFile("state.json"), lastRunInfo()]);
    const state = stateFile.text ? JSON.parse(stateFile.text) : {};
    return {
      now: new Date().toISOString(), run_info: runInfo,
      requests: data.requests.map((r) => ({
        ...r,
        check_times: r.check_times || DEFAULT_TIMES[r.daily_checks] || DEFAULT_TIMES[2],
        reminders_sent: state[`req:${r.id}`]?.reminders_sent || [],
        watches: (r.watches || []).map((w) => {
          const st = state[w.id] || {};
          return {
            ...w, checks: w.checks || [], status: watchStatus(w, st), last_check: st.last_check, last_result: st.last_result,
            last_error: st.last_error, next_check: w.enabled === false ? null : st.next_check, opened_at: st.opened_at,
            fails: st.fails || 0, checking: false,
          };
        }),
      })),
    };
  });

  on("POST", "/api/requests", async (_, b) => {
    if (!b.watches?.length) throw new Error("至少要有一個網址（或使用 AI 查詢）");
    if (!b.item) throw new Error("請填想訂的項目");
    const times = normalizeTimes(b.check_times?.length ? b.check_times : DEFAULT_TIMES[2]);
    const expected = b.open_local ? zonedToIso(b.open_local, b.open_tz || "Asia/Taipei") : (b.expected_open_at || "");
    return mutateReqs((reqs) => {
      const taken = takenIds(reqs);
      const id = uniqueId(`${b.item}-${b.target_date || ""}`, taken);
      taken.add(id);
      const r = { id, item: b.item, target_date: b.target_date || "", notes: b.notes || "", check_times: times,
        expected_open_at: expected, release_rule: b.release_rule || "", enabled: true,
        open_days_before: b.open_days_before, watches: b.watches.map((w) => makeWatch(w, id, taken)) };
      applyOpenRule(r, b.open_tz);
      for (const k of ["target_date", "notes", "expected_open_at", "release_rule"]) if (!r[k]) delete r[k];
      reqs.push(r);
      return { id };
    }, `新增需求：${b.item}`);
  });

  function findReq(reqs, rid) {
    const r = reqs.find((x) => x.id === rid);
    if (!r) throw new Error("找不到這個需求");
    return r;
  }
  function findWatch(reqs, wid) {
    for (const r of reqs) for (const w of r.watches || []) if (w.id === wid) return [r, w];
    throw new Error("找不到這個網站");
  }

  async function clearState(keys, msg) {
    await mutate("state.json", (st) => { for (const k of keys) delete st[k]; }, msg);
  }
  async function clearNextCheck(ids) {
    await mutate("state.json", (st) => { for (const k of ids) if (st[k]) delete st[k].next_check; }, "重新排程");
  }

  on("PATCH", "/api/requests/([^/]+)", async ([rid], b) => {
    const times = b.check_times ? normalizeTimes(b.check_times) : null;
    let dateChanged = false;
    const ids = await mutateReqs((reqs) => {
      const r = findReq(reqs, rid);
      dateChanged = b.target_date != null && b.target_date !== (r.target_date || "");
      for (const k of ["item", "target_date", "notes"]) if (b[k] != null) r[k] = b[k];
      if (times) r.check_times = times;
      if (b.open_local != null) r.expected_open_at = b.open_local ? zonedToIso(b.open_local, b.open_tz || "Asia/Taipei") : "";
      if (b.open_days_before != null) r.open_days_before = b.open_days_before;
      applyOpenRule(r, b.open_tz);
      if (b.enabled != null) { r.enabled = b.enabled; for (const w of r.watches || []) w.enabled = b.enabled; }
      if (b.add_watch) (r.watches ||= []).push(makeWatch(b.add_watch, r.id, takenIds(reqs)));
      return (r.watches || []).map((w) => w.id);
    }, `更新需求：${rid}`);
    // 換了目標日期：舊日期的結果（含「已開放」）不再適用，重新開始監控
    if (dateChanged) await clearState([...ids, `req:${rid}`], `換目標日期，重新監控：${rid}`);
    else if (times || b.open_local != null || b.open_days_before != null) await clearNextCheck(ids);
    return { ok: true };
  });

  on("DELETE", "/api/requests/([^/]+)", async ([rid]) => {
    const ids = await mutateReqs((reqs) => {
      const r = findReq(reqs, rid);
      reqs.splice(reqs.indexOf(r), 1);
      return (r.watches || []).map((w) => w.id);
    }, `刪除需求：${rid}`);
    await clearState([`req:${rid}`, ...ids], "清除狀態");
    return { ok: true };
  });

  on("PATCH", "/api/watches/([^/]+)", async ([wid], b) => {
    await mutateReqs((reqs) => {
      const [r, w] = findWatch(reqs, wid);
      if (b.url != null && !/^https?:\/\/[^\s]+$/i.test(String(b.url).trim())) throw new Error(`網址格式不正確：${b.url}`);
      for (const k of ["name", "url", "render", "match", "enabled"]) if (b[k] != null) w[k] = typeof b[k] === "string" ? b[k].trim() : b[k];
      if (b.checks) {
        const cks = b.checks.filter((c) => CHECK_TYPES.includes(c.type)).map((c) => (c.value ? { type: c.type, value: c.value } : { type: c.type }));
        w.checks = cks.length ? cks : [{ type: "ai" }];
      }
      if (b.enabled && r.enabled === false) r.enabled = true;
    }, `更新網站：${wid}`);
    if (b.url != null || b.checks) await clearState([wid], "條件變更，重新建立基準");
    return { ok: true };
  });

  on("DELETE", "/api/watches/([^/]+)", async ([wid]) => {
    await mutateReqs((reqs) => {
      const [r] = findWatch(reqs, wid);
      r.watches = r.watches.filter((w) => w.id !== wid);
    }, `刪除網站：${wid}`);
    await clearState([wid], "清除狀態");
    return { ok: true };
  });

  on("POST", "/api/watches/([^/]+)/reset", async ([wid]) => {
    await clearState([wid], `重設：${wid}`);
    return { ok: true };
  });

  on("POST", "/api/watches/([^/]+)/check", async ([wid]) => {
    await dispatch({ action: "check", target: wid });
    return { queued: true };
  });

  on("POST", "/api/research", async (_, b) => {
    if (metaCache && metaCache.research_provider === "none") throw new Error("請先在設定區填入 Groq、Gemini（免費）或 Claude 的 API Key");
    const job = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => x.toString(16).padStart(2, "0")).join("");
    await dispatch({ action: "research", item: b.item, date: b.target_date, notes: b.notes || "", job_id: job });
    return { job_id: job };
  });

  on("GET", "/api/jobs/([a-z0-9]+)", async ([job]) => {
    const f = await readFile(`research/${job}.json`);
    if (!f.text) return { status: "running", progress: ["GitHub Actions 執行中（啟動約 30 秒，AI 查詢約 1~3 分鐘）…"] };
    const res = JSON.parse(f.text);
    gh("DELETE", `${repoPath}/contents/research/${job}.json`, { message: "清除查詢結果", sha: f.sha }).catch(() => {});
    return res;
  });

  on("GET", "/api/settings", async () => {
    const { secrets, vars } = await repoConfig();
    const out = {};
    for (const [k, name] of Object.entries(SECRETS)) out[k] = secrets.has(name) ? "已設定（輸入新值可覆蓋）" : "";
    for (const [k, name] of Object.entries(VARS)) out[k] = vars[name] || "";
    return out;
  });

  async function setSecret(name, value) {
    const [{ key_id, key }, mod] = await Promise.all([gh("GET", `${repoPath}/actions/secrets/public-key`), import(SODIUM)]);
    const sodium = mod.default || mod;
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL));
    await gh("PUT", `${repoPath}/actions/secrets/${name}`, {
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id,
    });
  }
  async function setVar(name, value, existing) {
    if (!value) {
      if (name in existing) await gh("DELETE", `${repoPath}/actions/variables/${name}`);
      return;
    }
    if (existing[name] === value) return;
    if (name in existing) await gh("PATCH", `${repoPath}/actions/variables/${name}`, { name, value });
    else await gh("POST", `${repoPath}/actions/variables`, { name, value });
  }

  on("PUT", "/api/settings", async (_, b) => {
    if (b.ai_provider && !PROVIDERS.includes(b.ai_provider)) throw new Error("AI 來源不正確");
    for (const k of ["ai_max_per_site_day", "ai_max_per_day"]) if (b[k] && !/^\d+$/.test(b[k])) throw new Error("AI 次數上限必須是整數");
    if (b.daily_summary_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.daily_summary_time)) throw new Error("總覽時間格式請用 HH:MM，例如 23:00");
    const { vars } = await repoConfig();
    let n = 0;
    for (const [k, name] of Object.entries(SECRETS)) {
      const v = (b[k] || "").trim();
      if (v && !v.startsWith("已設定")) { await setSecret(name, v); n++; }
    }
    for (const [k, name] of Object.entries(VARS)) {
      if (b[k] == null) continue;
      await setVar(name, String(b[k]).trim(), vars);
      n++;
    }
    return { ok: true, updated: n };
  });

  on("POST", "/api/settings/test-notify", async () => {
    if (metaCache && !metaCache.channels.length) throw new Error("還沒有設定完整的 Telegram（Bot Token 與 Chat ID 都要儲存）");
    await dispatch({ action: "test-notify" });
    return { queued: true };
  });

  on("POST", "/api/settings/summary-now", async () => {
    if (metaCache && !metaCache.channels.length) throw new Error("還沒有設定完整的 Telegram（Bot Token 與 Chat ID 都要儲存）");
    await dispatch({ action: "summary" });
    return { queued: true };
  });

  on("POST", "/api/settings/telegram-chat-id", async (_, b) => {
    const token = (b.token || "").trim();
    if (!token || token.startsWith("已設定")) throw new Error("請在 Bot Token 欄位貼上 token 再按（GitHub 版讀不到已存的 token）");
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token).replace(/%3A/g, ":")}/getUpdates`);
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error("Telegram 回應錯誤：" + (d.description || r.status) + "（請確認 token 正確）");
    const seen = new Map();
    for (const u of d.result || []) {
      const chat = (u.message || u.channel_post || {}).chat;
      if (chat) seen.set(chat.id, chat.username || chat.title || chat.first_name || "");
    }
    return { chats: [...seen].map(([id, name]) => ({ id, name })) };
  });

  on("POST", "/api/logout", async () => {
    localStorage.removeItem(LS_KEY);
    return { ok: true };
  });

  on("POST", "/api/password", async () => { throw new Error("GitHub 版用 GitHub token 登入，不需要密碼"); });

  window.BACKEND = {
    loginUrl: "login.html",
    async request(method, path, body) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (m) return r.fn(m.slice(1).map(decodeURIComponent), body || {});
      }
      throw new Error(`GitHub 版不支援：${method} ${path}`);
    },
  };
})();
