"use strict";
// 同一份介面兩種用法：本機伺服器（/api/...）或 GitHub 版（static/backend.js 提供 window.BACKEND）
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  watching: "監控中", pending: "等待首次檢查", opened: "已開放！", error: "讀取失敗",
  paused: "已暫停", expired: "已過期", checking: "檢查中…",
};
const CHECK_TYPES = {
  ai: "AI 判斷", text_absent: "文字消失", text_present: "文字出現", date_present: "出現目標日期",
  selector_enabled: "按鈕可點", selector_exists: "元素出現", selector_absent: "元素消失", changed: "頁面有變動",
  open_time: "到達預計開放時間", booking_dates: "訂票系統可訂日期",
};
const NO_VALUE = new Set(["date_present", "changed", "open_time"]);
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TZS = [...new Set([LOCAL_TZ, "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Asia/Hong_Kong", "Asia/Shanghai",
  "Asia/Singapore", "Asia/Bangkok", "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Australia/Sydney"])];
const PROVIDER = { groq: "Groq", claude: "Claude", gemini: "Gemini", none: "無" };

let META = null;
let DATA = { requests: [] };
const expanded = new Set();
const checking = new Set();

// ------------------------------------------------------------ helpers
async function api(method, path, body) {
  if (window.BACKEND) return window.BACKEND.request(method, path, body);
  const r = await fetch(path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { location.href = "/login"; throw new Error("請先登入"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = data.detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join("；") : d || `錯誤 ${r.status}`);
  }
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  $(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 6000 : 3000);
}

const pad = (n) => String(n).padStart(2, "0");
function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function rel(iso) {
  if (!iso) return "";
  const diff = (new Date(iso) - Date.now()) / 60000;
  const a = Math.abs(diff);
  let s;
  if (a < 1) return diff >= 0 ? "即將" : "剛剛";
  if (a < 60) s = `${Math.round(a)} 分鐘`;
  else if (a < 48 * 60) s = `${Math.round(a / 60)} 小時`;
  else s = `${Math.round(a / 1440)} 天`;
  return diff >= 0 ? `${s}後` : `${s}前`;
}
function tzName(tz) {
  const n = { "Asia/Taipei": "台北", "Asia/Tokyo": "東京", "Asia/Seoul": "首爾", "Asia/Hong_Kong": "香港",
    "Asia/Shanghai": "上海", "Asia/Singapore": "新加坡", "Asia/Bangkok": "曼谷", "Europe/London": "倫敦",
    "Europe/Paris": "巴黎", "America/New_York": "紐約", "America/Los_Angeles": "洛杉磯", "Australia/Sydney": "雪梨" }[tz];
  return n ? `${n}（${tz}）` : tz;
}
function toLocalInput(iso, tz) {
  if (!iso) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** 預計開放時間：本機時間；原始時區不同時也附上當地時間 */
function openAtText(iso) {
  const d = new Date(iso);
  const off = iso.match(/([+-]\d\d:\d\d|Z)$/)?.[1];
  const localOff = -d.getTimezoneOffset();
  let s = fmt(iso);
  if (off && off !== "Z") {
    const [h, m] = off.slice(1).split(":").map(Number);
    const mins = (off[0] === "-" ? -1 : 1) * (h * 60 + m);
    if (mins !== localOff) {
      const t = new Date(d.getTime() + (mins - localOff) * 60000);
      s += `（當地 ${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}，UTC${off}）`;
    }
  }
  return s;
}
/** ISO 字串的時差 → 清單中第一個相同時差的時區（例：+09:00 → Asia/Tokyo） */
function tzFromIso(iso) {
  const off = /([+-])(\d\d):(\d\d)$/.exec(iso || "");
  if (!off) return "";
  const mins = (off[1] === "-" ? -1 : 1) * (+off[2] * 60 + +off[3]);
  const at = new Date(iso);
  return TZS.find((tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
    return Math.round((Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - at) / 60000) === mins;
  }) || "";
}
function tzOptions(sel, value) {
  sel.innerHTML = TZS.map((t) => `<option value="${t}" ${t === value ? "selected" : ""}>${esc(tzName(t))}</option>`).join("");
}

// ------------------------------------------------------------ 每天檢查時間編輯器
function renderTimes(box, times) {
  const n = times.length;
  box.innerHTML = `
    <div class="seg">${[1, 2, 3].map((k) =>
      `<label><input type="radio" name="tcount" value="${k}" ${k === n ? "checked" : ""}><span>每天 ${k} 次</span></label>`).join("")}
    </div>
    <div class="row time-list" style="flex-wrap:wrap;margin-top:8px">
      ${times.map((t) => `<input type="time" class="t-in" value="${esc(t)}" style="width:auto" required>`).join("")}
    </div>`;
  box.onchange = (e) => {
    if (e.target.name !== "tcount") return;
    const k = +e.target.value;
    const cur = readTimes(box);
    const defaults = META.default_times[k];
    renderTimes(box, cur.length === k ? cur : defaults);
  };
}
function readTimes(box) {
  return $$(".t-in", box).map((i) => i.value).filter(Boolean);
}

// 這些網站有防機器人機制，程式讀不到（會顯示「讀取失敗 403」）
const BLOCKED = /(^|\.)(klook\.com|klook\.cn|kkday\.com|trip\.com|ctrip\.com|webket\.jp|agoda\.com|booking\.com)$/i;
function confirmBlocked(urls) {
  const bad = urls.filter((u) => { try { return BLOCKED.test(new URL(u).hostname); } catch { return false; } });
  if (!bad.length) return true;
  return confirm(
    `下列網站會擋程式，監控會一直「讀取失敗」：\n${bad.join("\n")}\n\n` +
    "建議改用「🤖 AI 自動查詢」找官方網站，或自己貼官方網站的網址。\n仍要新增嗎？");
}

// ------------------------------------------------------------ 分頁、主題
const TABS = ["main", "settings", "guide"];
function showTab(name) {
  $$(".tabs [data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".page").forEach((p) => (p.hidden = p.id !== `page-${name}`));
  try { localStorage.setItem("br_tab", name); } catch {}
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0 });
}
$$(".tabs [data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => {
  const h = location.hash.slice(1);
  if (TABS.includes(h)) showTab(h);
  else if (h.startsWith("g-")) { const el = document.getElementById(h); if (el) { showTab("guide"); el.scrollIntoView(); } }
});
showTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1)
  : (() => { try { return localStorage.getItem("br_tab") || "main"; } catch { return "main"; } })());

function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function paintThemeBtn() {
  const dark = currentTheme() === "dark";
  $("#themeBtn").innerHTML = dark ? "☀️<span class=\"lbl\"> 明亮</span>" : "🌙<span class=\"lbl\"> 深色</span>";
  $("#themeBtn").title = dark ? "切換成明亮高對比" : "切換成深色";
}
$("#themeBtn").onclick = () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("br_theme", next); } catch {}
  paintThemeBtn();
};
paintThemeBtn();

// ------------------------------------------------------------ init
async function init() {
  META = await api("GET", "/api/meta");
  renderTimes($("#addForm [data-times]"), META.default_times[2]);
  $$(".tzlabel").forEach((el) => (el.textContent = `（${tzName(META.check_tz)}；建議保留早上一次）`));
  tzOptions($("#tzSelect"), LOCAL_TZ);
  tzOptions($("#editForm [name=open_tz]"), LOCAL_TZ);
  renderMeta();
  await Promise.all([loadSettings(), refresh()]);
  setInterval(() => { if (!document.hidden) refresh(); }, META.mode === "github" ? 30000 : 10000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

function renderMeta() {
  const ch = META.channels;
  const gh = META.mode === "github";
  $("#badges").innerHTML =
    `<span class="badge key ${ch.includes("telegram") ? "on" : "off"}" title="${ch.includes("telegram") ? "Telegram 已設定" : "Telegram 未設定"}"><i class="dot"></i><i class="lng">Telegram</i><i class="sh">TG</i></span>` +
    (ch.includes("line") ? `<span class="badge on">LINE</span>` : "") +
    `<span class="badge key ${META.has_ai ? "on" : "off"}" title="${META.has_ai ? "AI 已設定：" + PROVIDER[META.ai_provider] : "AI 未設定"}"><i class="dot"></i>AI<i class="lng">${META.has_ai ? "：" + PROVIDER[META.ai_provider] : ""}</i></span>` +
    (META.research_provider && META.research_provider !== "none" && META.research_provider !== META.ai_provider
      ? `<span class="badge on" title="AI 自動查詢用這一家">查詢：${PROVIDER[META.research_provider]}</span>` : "") +
    (gh ? `<span class="badge on">GitHub</span>` : "");
  $("#logout").hidden = !(gh || META.password_set);
  const b = [];
  if (!ch.length) b.push(`還沒設定通知管道，開放時無法通知你 → <a href="#settings">前往設定</a>`);
  if (!META.has_ai) b.push(`還沒設定 AI：無法使用 AI 自動查詢與判斷，只能自己填網址（Groq、Gemini 有免費方案）→ <a href="#settings">前往設定</a>`);
  if (!gh && !META.password_set) b.push(`還沒設定登入密碼，手機無法登入 → <a href="#settings">設定密碼</a>`);
  $("#banners").innerHTML = b.map((x) => `<div class="banner">${x}</div>`).join("");

  const [perSite, total] = META.ai_limits || [6, 30];
  const used = META.ai_usage?.total ?? 0;
  $("#aiUsage").textContent = `今天 AI 已呼叫 ${used} / ${total} 次（每個網站每天最多 ${perSite} 次；頁面沒變時沿用上次判斷，不會重複呼叫）。`;

  $("#pwSection").hidden = gh;
  $("#ghSection").hidden = !gh;
  $("#secretHint").textContent = gh
    ? "金鑰會加密後存進 GitHub Secrets，存了之後網頁上看不到內容（顯示「已設定」）。要修改直接輸入新的值即可。"
    : "金鑰存在這台電腦的 .env，網頁上只顯示最後 4 碼。";
  if (gh) {
    $("#ghBox").innerHTML = META.gh_html;
    return;
  }
  $("#curPwField").hidden = !META.password_set;
  $("#pwBtn").textContent = META.password_set ? "變更密碼" : "設定密碼";
  let phone;
  if (!META.password_set) phone = "先在下方設定登入密碼。";
  else if (META.phone_url) phone = `手機連同一個 Wi-Fi，用瀏覽器打開：<br><code>${esc(META.phone_url)}</code><br><span class="hint">在外面（4G/5G）也要用：電腦和手機都安裝 Tailscale，改用 Tailscale 顯示的電腦 IP。登入後可「加入主畫面」。</span>`;
  else phone = `目前只開放本機。要讓手機登入，請用 <code>python -m booking_reminder ui --phone</code> 啟動。`;
  $("#phoneBox").innerHTML = phone;
}

// ------------------------------------------------------------ ① 新增需求
$("#addForm").addEventListener("change", (e) => {
  if (e.target.name === "mode") $("#urlsField").hidden = e.target.value !== "manual";
});

function formBase(f) {
  const fd = new FormData(f);
  return {
    item: (fd.get("item") || "").trim(), target_date: fd.get("target_date") || "", notes: (fd.get("notes") || "").trim(),
    check_times: readTimes($("[data-times]", f)),
    open_local: fd.get("open_local") || "", open_tz: fd.get("open_tz") || "",
    ...(fd.has("open_days_before") ? { open_days_before: Math.max(0, parseInt(fd.get("open_days_before"), 10) || 0) } : {}),
  };
}

// 編輯視窗：有「入場日前 N 天」規則時，改目標日期／天數 → 預計開放日期立刻跟著變（時刻保留）
function ruleDate(target, n) {
  const d = new Date(target + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
$("#editForm").addEventListener("input", (e) => {
  if (!["target_date", "open_days_before"].includes(e.target.name)) return;
  const el = e.currentTarget.elements;
  const n = parseInt(el.open_days_before.value, 10) || 0;
  if (n > 0 && /^\d{4}-\d\d-\d\d$/.test(el.target_date.value)) {
    el.open_local.value = ruleDate(el.target_date.value, n) + "T" + (el.open_local.value.slice(11) || "00:00");
  }
});

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const base = formBase(f);
  if (!base.check_times.length) return toast("請至少設定一個檢查時間", true);
  const mode = new FormData(f).get("mode");
  if (mode === "manual") {
    const urls = new FormData(f).get("urls").split(/\s+/).filter(Boolean);
    if (!urls.length) return toast("請填至少一個網址", true);
    if (!confirmBlocked(urls)) return;
    try {
      await api("POST", "/api/requests", { ...base, watches: urls.map((url) => ({ url })) });
      toast(META.mode === "github" ? "✅ 已新增，下一次 GitHub 排程會開始檢查" : "✅ 已新增，馬上開始第一次檢查");
      resetAddForm();
      refresh();
    } catch (err) { toast(err.message, true); }
    return;
  }
  // AI 查詢
  const box = $("#research");
  box.hidden = false;
  const who = PROVIDER[META.research_provider] || "AI";
  box.innerHTML = `<div class="progress"><span class="spinner"></span>${who} 正在上網查詢官方網站與開放規則…</div>`;
  $("#addBtn").disabled = true;
  try {
    const { job_id } = await api("POST", "/api/research", { item: base.item, target_date: base.target_date, notes: base.notes });
    const t0 = Date.now();
    let netFails = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, META.mode === "github" ? 8000 : 2500));
      let job;
      try {
        job = await api("GET", `/api/jobs/${job_id}`);
        netFails = 0;
      } catch (e) {   // 手機網路短暫斷線：查詢仍在 GitHub 上跑，繼續等
        if (++netFails >= 6) throw e;
        continue;
      }
      const sec = Math.round((Date.now() - t0) / 1000);
      if (job.status === "running") {
        box.querySelector(".progress").innerHTML = `<span class="spinner"></span>${esc(job.progress.at(-1) || "查詢中…")}（${sec} 秒）`;
        if (sec > 900) throw new Error("查詢超過 15 分鐘仍沒有結果，請到 GitHub Actions 頁面查看執行紀錄");
        continue;
      }
      if (job.status === "error") throw new Error("AI 查詢失敗：" + job.error);
      showSuggestions(job.result, base);
      break;
    }
  } catch (err) {
    box.innerHTML = `<div class="banner">${esc(err.message)}</div>`;
  } finally {
    $("#addBtn").disabled = false;
  }
});

function showSuggestions(res, base) {
  const box = $("#research");
  const items = [
    ...res.watches.map((w) => ({ ...w, checked: true, tag: "建議" })),
    ...res.alternatives.filter((a) => /^https?:\/\//.test(a.url) && !res.watches.some((w) => w.url === a.url))
      .map((a) => ({ name: a.name, url: a.url, notes: a.note, render: false, match: "any", checks: [], checked: false, tag: "其他管道" })),
  ];
  box.innerHTML = `
    <p class="summary">${esc(res.summary)}</p>
    ${res.release_rule ? `<p class="hint">開放規則：${esc(res.release_rule)}</p>` : ""}
    <p class="hint">預計開放：${res.expected_open_at ? `<b>${esc(openAtText(res.expected_open_at))}</b>（到時會多檢查一次）` : "查不到確切時間"}
      ${base.open_local ? "（你有手動填寫，會以你填的為準）" : ""}</p>
    <div style="margin:12px 0 4px;font-weight:600">勾選要監控的網站：</div>
    ${items.length ? items.map((w, i) => `
      <label class="suggest">
        <input type="checkbox" data-i="${i}" ${w.checked ? "checked" : ""}>
        <div><b>${esc(w.name)}</b> <span class="badge">${w.tag}</span>
          <div class="u">${esc(w.url)}</div>
          ${w.notes ? `<div class="hint">${esc(w.notes)}</div>` : ""}
          ${w.checks.length ? `<div class="hint">偵測：${w.checks.map((c) => esc((CHECK_TYPES[c.type] || c.type) + (c.value && c.type !== "ai" ? `「${c.value}」` : ""))).join("、")}</div>` : ""}
        </div>
      </label>`).join("") : `<div class="hint">AI 沒有找到可監控的網址，請改用「自己填網址」。</div>`}
    ${res.tips.length ? `<details class="report"><summary>實用建議（${res.tips.length}）</summary><ul>${res.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>` : ""}
    <details class="report"><summary>完整調查報告</summary><pre>${esc(res.report)}</pre></details>
    <div class="actions">
      <button type="button" id="cancelSug">取消</button>
      <button type="button" class="primary" id="confirmSug">加入監控</button>
    </div>`;
  $("#cancelSug").onclick = () => { box.hidden = true; };
  $("#confirmSug").onclick = async () => {
    const picked = $$("input[data-i]:checked", box).map((c) => items[+c.dataset.i]);
    if (!picked.length) return toast("請至少勾選一個網站", true);
    try {
      await api("POST", "/api/requests", {
        ...base, expected_open_at: res.expected_open_at, release_rule: res.release_rule,
        watches: picked.map(({ name, url, render, match, checks, notes }) => ({ name, url, render, match, checks, notes })),
      });
      toast("✅ 已加入監控");
      box.hidden = true;
      resetAddForm();
      refresh();
    } catch (err) { toast(err.message, true); }
  };
}

function resetAddForm() {
  const f = $("#addForm");
  f.reset();
  $("#urlsField").hidden = true;
  renderTimes($("[data-times]", f), META.default_times[2]);
  tzOptions($("#tzSelect"), LOCAL_TZ);
}

// ------------------------------------------------------------ ② 監控狀態
async function refresh() {
  try {
    DATA = await api("GET", "/api/requests");
    $("#updated").textContent = `更新於 ${fmt(DATA.now)}`;
    if (DATA.run_info) { $("#runInfo").hidden = false; $("#runInfo").innerHTML = DATA.run_info; }
    const active = document.activeElement;
    if (active && $("#reqList").contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName)) return;
    renderList();
  } catch (err) { $("#updated").textContent = "⚠️ " + err.message; }
}

// ------------------------------------------------------------ 已開放提醒（置頂＋發光＋進站跳窗，直到刪除）
const openedWatches = (r) => r.watches.filter((w) => w.status === "opened");
const openedAt = (r) => Math.max(0, ...openedWatches(r).map((w) => Date.parse(w.opened_at) || 0));
function bookingUrl(w) {
  const m = /訂購連結：(https?:\/\/\S+)/.exec(w.last_result || "");
  return m ? m[1] : w.url;
}
// 「稍後再說」= 這些項目 30 分鐘內不再跳窗；超過 30 分鐘再進網站、或有新的項目開放，會再跳出
const SNOOZE_KEY = "br_open_snooze", SNOOZE_MS = 30 * 60e3;
function snoozed() {
  try {
    const v = JSON.parse(localStorage.getItem(SNOOZE_KEY) || "{}");
    return Date.now() < (v.until || 0) ? new Set(v.keys || []) : new Set();
  } catch { return new Set(); }
}
function snooze(keys) {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ keys, until: Date.now() + SNOOZE_MS })); } catch {}
}
function openAlert(reqs, force = false) {
  const hot = reqs.filter((r) => openedWatches(r).length).sort((a, b) => openedAt(b) - openedAt(a));
  document.title = hot.length ? `🎫(${hot.length}) 可以訂了｜訂票監控` : "訂票監控";
  const chip = $("#openChip");
  if (chip) { chip.hidden = !hot.length; $("b", chip).textContent = hot.length; }
  const hb = $("#hotBanner");
  if (hb) {
    hb.hidden = !hot.length;
    if (hot.length) hb.innerHTML = `🎫 <b>${esc(hot.map((r) => r.item).join("、"))}</b> 可以訂了！<button type="button" class="link" data-go="${esc(hot[0].id)}">查看 ↓</button>`;
  }
  const dlg = $("#openDlg");
  if (!dlg) return;
  const keys = hot.flatMap((r) => openedWatches(r).map((w) => w.id + "@" + (w.opened_at || "")));
  const seen = snoozed();
  if (!hot.length) { if (dlg.open) dlg.close(); return; }
  if (!force && keys.every((k) => seen.has(k))) return;
  $("#openList").innerHTML = hot.map((r) => `
    <div class="open-item">
      <div class="oi-t"><b>${esc(r.item)}</b>
        <small>${r.target_date ? `📅 ${esc(r.target_date)} · ` : ""}${fmt(new Date(openedAt(r)).toISOString())} 偵測到開放</small></div>
      ${openedWatches(r).map((w) => `<a class="go" href="${esc(bookingUrl(w))}" target="_blank" rel="noopener" title="${esc(w.name)}"><span>前往訂購：${esc(w.name)}</span> ↗</a>`).join("")}
      <button type="button" class="small danger" data-act="doneReq" data-rid="${esc(r.id)}">我訂好了，刪除這個需求</button>
    </div>`).join("");
  dlg.dataset.keys = JSON.stringify(keys);
  if (!dlg.open) dlg.showModal();
}

function renderList() {
  const reqs = DATA.requests;
  if (!reqs.length) {
    $("#reqList").innerHTML = `<div class="empty">還沒有任何需求，從上面新增一個吧。</div>`;
    openAlert(reqs);
    return;
  }
  // 已開放的需求排最前面（最近開放的在上），其餘維持原順序
  const sorted = reqs.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (openedAt(b) - openedAt(a)) || (i - j)).map(([r]) => r);
  $("#reqList").innerHTML = sorted.map(renderReq).join("");
  openAlert(reqs);
  // GitHub 排程延遲：有網站超過預定檢查時間 1 小時還沒檢查 → 提醒設定準時觸發器
  const late = reqs.flatMap((r) => r.watches).filter((w) =>
    w.next_check && !["opened", "expired", "paused"].includes(w.status) && Date.now() - Date.parse(w.next_check) > 3600e3);
  const box = $("#lateBanner");
  if (box) {
    box.hidden = !(late.length && META.mode === "github");
    box.innerHTML = `⏱ 有 ${late.length} 個網站已超過預定檢查時間 1 小時以上（GitHub 排程延遲）。建議設定 <a href="#g-trigger">準時觸發器</a>。`;
  }
}

function renderReq(r) {
  const open = r.expected_open_at
    ? `<span>預計開放 <span class="open-at">${esc(openAtText(r.expected_open_at))}</span>
        ${new Date(r.expected_open_at) > Date.now() ? `<span class="countdown">· ${rel(r.expected_open_at)}</span>` : ""}</span>`
    : `<span>預計開放：未知</span>`;
  const hot = openedWatches(r);
  const hotBar = hot.length ? `
    <div class="hot-bar">
      <span class="hb-t">🎫 可以訂了！${hot.map((w) => esc(w.name)).join("、")} 已開放</span>
      <span class="hb-b">
        ${hot.map((w) => `<a class="go small" href="${esc(bookingUrl(w))}" target="_blank" rel="noopener">前往${hot.length > 1 ? " " + esc(w.name) : ""}訂購 ↗</a>`).join("")}
        <button class="small danger" data-act="doneReq" data-rid="${esc(r.id)}">訂好了，刪除</button>
      </span>
    </div>` : "";
  return `
  <div class="req ${r.enabled === false ? "paused" : ""} ${hot.length ? "hot" : ""}" id="req-${esc(r.id)}">
    ${hotBar}
    <div class="req-head">
      <div class="t">
        <b>${esc(r.item)}</b>
        <div class="meta">
          <span>📅 ${esc(r.target_date || "未指定日期")}</span>
          <span>⏰ 每天 ${esc((r.check_times || []).join("、"))} 檢查</span>
          ${open}
        </div>
        ${r.open_days_before ? `<div class="hint">🗓 開賣規則：入場日前 ${esc(r.open_days_before)} 天（改目標日期會自動重算開放時間）</div>` : ""}
        ${r.release_rule ? `<div class="hint">${esc(r.release_rule)}</div>` : ""}
        ${r.notes ? `<div class="hint">📝 ${esc(r.notes)}</div>` : ""}
      </div>
      <div class="btns">
        <button class="small" data-act="addSite" data-rid="${esc(r.id)}">＋網站</button>
        <button class="small" data-act="editReq" data-rid="${esc(r.id)}">編輯</button>
        <button class="small" data-act="toggleReq" data-rid="${esc(r.id)}">${r.enabled === false ? "恢復" : "暫停"}</button>
        <button class="small danger" data-act="delReq" data-rid="${esc(r.id)}">刪除</button>
      </div>
    </div>
    ${r.watches.length ? `
    <table class="w">
      <thead><tr><th>網站</th><th>狀態</th><th>上次確認</th><th>結果</th><th>下次確認</th><th></th></tr></thead>
      <tbody>${r.watches.map(renderWatch).join("")}</tbody>
    </table>` : `<div class="empty">這個需求還沒有網站，按「＋網站」新增。</div>`}
  </div>`;
}

function firstLine(s) {
  return (s || "").split("\n").filter(Boolean).slice(0, 2).join("\n");
}

// 這個網站「每天檢查」實際讀的是什麼：訂票系統本身／介紹頁（間接）／只看時間（讀不到）
function sourceTag(w) {
  const types = new Set((w.checks || []).map((c) => c.type));
  if (types.has("booking_dates")) return `<span class="src good" title="每次檢查都直接讀訂票系統的可訂日期">✅ 直接讀訂票系統</span>`;
  if (types.size && [...types].every((t) => t === "open_time"))
    return `<span class="src warn" title="訂票系統擋程式，每天檢查只能比對時間，無法確認真的開了">⏰ 只看時間，無法實際確認</span>`;
  return `<span class="src mid" title="讀的是介紹頁，不是訂票日曆；訂票系統可能比介紹頁早開">📄 讀介紹頁（間接）</span>`;
}

function renderWatch(w) {
  const st = checking.has(w.id) || w.checking ? "checking" : w.status;
  const stClass = st === "checking" ? "watching checking" : st;
  const next = w.next_check && !["opened", "expired", "paused"].includes(w.status)
    ? `${fmt(w.next_check)}<small>${rel(w.next_check)}</small>`
    : w.status === "pending" ? `<small>${META.mode === "github" ? "下一次排程" : "馬上"}</small>` : "—";
  const main = `
    <tr class="main" data-act="expand" data-wid="${esc(w.id)}">
      <td class="c-site site"><b>${esc(w.name)}</b>${sourceTag(w)}<a href="${esc(w.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(w.url)}</a></td>
      <td class="c-status"><span class="st ${stClass}">${STATUS[st] || st}</span></td>
      <td class="c-last time">${w.last_check ? `${fmt(w.last_check)}<small>${rel(w.last_check)}</small>` : "—"}</td>
      <td class="c-result"><div class="result">${esc(firstLine(w.last_result) || "尚未檢查")}</div></td>
      <td class="c-next time">${next}</td>
      <td class="c-act"><button class="small" data-act="check" data-wid="${esc(w.id)}" ${st === "checking" ? "disabled" : ""}>立即檢查</button></td>
    </tr>`;
  if (!expanded.has(w.id)) return main;
  return main + `
    <tr class="detail"><td colspan="6"><div class="detail-box">
      <div><b>完整結果</b><pre>${esc(w.last_result || "尚未檢查")}</pre>
        ${w.last_error ? `<pre style="color:var(--bad)">${esc(w.last_error)}（連續失敗 ${w.fails} 次）</pre>` : ""}
        ${w.opened_at ? `<div class="hint">🎫 ${fmt(w.opened_at)} 偵測到開放並已通知</div>` : ""}
      </div>
      <div class="checks-edit" data-wid="${esc(w.id)}">
        <b>偵測條件</b>
        <div class="ck-list">${w.checks.map(ckRow).join("")}</div>
        <button type="button" class="link" data-act="addCk">＋新增條件</button>
        <div class="row" style="flex-wrap:wrap;gap:14px;margin-top:6px">
          <label class="row hint"><span>條件判斷：</span>
            <select class="ck-match" style="width:auto">
              <option value="any" ${w.match === "any" ? "selected" : ""}>任一成立就通知</option>
              <option value="all" ${w.match === "all" ? "selected" : ""}>全部成立才通知</option>
            </select></label>
          <label class="row hint"><input type="checkbox" class="ck-render" ${w.render ? "checked" : ""}> 網站需要 JavaScript（用瀏覽器開）</label>
        </div>
      </div>
      <div class="row" style="flex-wrap:wrap">
        <button class="small primary" data-act="saveCk" data-wid="${esc(w.id)}">儲存條件</button>
        <button class="small" data-act="reset" data-wid="${esc(w.id)}">重設狀態</button>
        <button class="small" data-act="toggleWatch" data-wid="${esc(w.id)}" data-enabled="${w.enabled !== false}">${w.enabled === false ? "恢復此網站" : "暫停此網站"}</button>
        <button class="small danger" data-act="delWatch" data-wid="${esc(w.id)}">刪除此網站</button>
      </div>
    </div></td></tr>`;
}

function ckRow(c = { type: "ai", value: "" }) {
  return `<div class="ck">
    <select class="ck-type">${Object.entries(CHECK_TYPES).map(([k, v]) => `<option value="${k}" ${k === c.type ? "selected" : ""}>${v}</option>`).join("")}</select>
    <input type="text" class="ck-value" value="${esc(c.value || "")}" placeholder="${placeholderFor(c.type)}" ${NO_VALUE.has(c.type) ? "disabled" : ""}>
    <button type="button" class="link danger" data-act="rmCk">✕</button>
  </div>`;
}
function placeholderFor(t) {
  return { ai: "補充說明（選填）", text_absent: "例：準備中", text_present: "例：予約する", selector_enabled: "CSS，例：button.buy",
    selector_exists: "CSS selector", selector_absent: "CSS selector",
    booking_dates: "資料網址，可用 {date}、{yyyymm}、{today}" }[t] || "";
}

$("#reqList").addEventListener("change", (e) => {
  if (e.target.classList.contains("ck-type")) {
    const v = e.target.closest(".ck").querySelector(".ck-value");
    v.disabled = NO_VALUE.has(e.target.value);
    v.placeholder = placeholderFor(e.target.value);
  }
});

$("#reqList").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const { act, wid, rid } = el.dataset;
  if (act !== "expand") e.stopPropagation();
  try {
    switch (act) {
      case "expand":
        expanded.has(wid) ? expanded.delete(wid) : expanded.add(wid);
        return renderList();
      case "check": {
        checking.add(wid); renderList();
        try {
          const r = await api("POST", `/api/watches/${wid}/check`);
          if (r.queued) toast("已請 GitHub Actions 檢查，約 1~2 分鐘後更新結果");
          else toast(r.is_open ? "🎫 已開放！已發送通知" : "檢查完成：尚未開放");
        } finally { checking.delete(wid); }
        break;
      }
      case "addCk":
        el.previousElementSibling.insertAdjacentHTML("beforeend", ckRow());
        return;
      case "rmCk":
        el.closest(".ck").remove();
        return;
      case "saveCk": {
        const box = $(`.checks-edit[data-wid="${CSS.escape(wid)}"]`);
        const checks = $$(".ck", box).map((r) => ({ type: $(".ck-type", r).value, value: $(".ck-value", r).value.trim() }));
        await api("PATCH", `/api/watches/${wid}`, { checks, match: $(".ck-match", box).value, render: $(".ck-render", box).checked });
        toast("✅ 條件已儲存，會重新建立比對基準");
        break;
      }
      case "reset":
        await api("POST", `/api/watches/${wid}/reset`);
        toast("已重設，會重新監控");
        break;
      case "toggleWatch":
        await api("PATCH", `/api/watches/${wid}`, { enabled: el.dataset.enabled !== "true" });
        break;
      case "delWatch":
        if (!confirm("確定刪除這個網站？")) return;
        await api("DELETE", `/api/watches/${wid}`);
        break;
      case "toggleReq": {
        const r = DATA.requests.find((x) => x.id === rid);
        await api("PATCH", `/api/requests/${rid}`, { enabled: r.enabled === false });
        break;
      }
      case "doneReq":
      case "delReq":
        if (!confirm(act === "doneReq" ? "已經訂好了嗎？會刪除這個需求，之後不再提醒。" : "確定刪除這個需求與底下所有網站？")) return;
        await api("DELETE", `/api/requests/${rid}`);
        toast("已刪除");
        break;
      case "editReq":
        return openEdit(rid);
      case "addSite":
        $("#siteForm").reset();
        $("#siteForm").dataset.rid = rid;
        return $("#siteDlg").showModal();
    }
  } catch (err) { toast(err.message, true); }
  refresh();
});

$("#openDlg").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act=doneReq]");
  if (!el) return;
  if (!confirm("已經訂好了嗎？會刪除這個需求，之後不再提醒。")) return;
  try {
    await api("DELETE", `/api/requests/${el.dataset.rid}`);
    toast("已刪除，祝旅途愉快！");
  } catch (err) { return toast(err.message, true); }
  refresh();
});
$("#openDlg").addEventListener("close", () => snooze(JSON.parse($("#openDlg").dataset.keys || "[]")));
$("#hotBanner").addEventListener("click", (e) => {
  const id = e.target.closest("[data-go]")?.dataset.go;
  if (!id) return;
  showTab("main");
  requestAnimationFrame(() => document.getElementById("req-" + id)?.scrollIntoView({ block: "start" }));
});
$("#openChip").onclick = () => openAlert(DATA.requests, true);

function openEdit(rid) {
  const r = DATA.requests.find((x) => x.id === rid);
  const f = $("#editForm");
  const el = f.elements;
  f.dataset.rid = rid;
  el.namedItem("item").value = r.item;   // elements.item 是內建方法，要用 namedItem
  el.target_date.value = r.target_date || "";
  el.notes.value = r.notes || "";
  renderTimes($("[data-times]", f), r.check_times || META.default_times[2]);
  tzOptions(el.open_tz, LOCAL_TZ);
  el.open_days_before.value = r.open_days_before || "";
  // 有規則時用原本的時區顯示，避免換算時區後日期跑掉
  const tz = r.open_days_before ? (tzFromIso(r.expected_open_at) || LOCAL_TZ) : LOCAL_TZ;
  tzOptions(el.open_tz, tz);
  el.open_local.value = toLocalInput(r.expected_open_at, tz);
  $("#editDlg").showModal();
}

$("#editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = formBase(f);
  if (!body.check_times.length) return toast("請至少設定一個檢查時間", true);
  try {
    await api("PATCH", `/api/requests/${f.dataset.rid}`, body);
    $("#editDlg").close();
    toast("✅ 已更新");
    refresh();
  } catch (err) { toast(err.message, true); }
});

$("#siteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const el = f.elements;
    if (!confirmBlocked([el.url.value.trim()])) return;
    await api("PATCH", `/api/requests/${f.dataset.rid}`, { add_watch: { url: el.url.value.trim(), name: el.name.value.trim() } });
    $("#siteDlg").close();
    toast("✅ 已新增網站");
    refresh();
  } catch (err) { toast(err.message, true); }
});

// ------------------------------------------------------------ ③ 設定
async function loadSettings() {
  const s = await api("GET", "/api/settings");
  for (const f of [$("#setForm"), $("#sumForm")]) {
    for (const [k, v] of Object.entries(s)) {
      const input = f.elements.namedItem(k);
      if (!input) continue;
      if (input.type === "password") { input.value = ""; input.placeholder = v || input.dataset.ph || input.placeholder; }
      else input.value = v ?? "";
    }
  }
  const t = $("#sumForm").elements.namedItem("daily_summary_time");
  if (!t.value) t.value = "23:00";
}

$("#sumForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    await api("PUT", "/api/settings", body);
    toast(body.daily_summary ? `✅ 已開啟，每天 ${body.daily_summary_time || "23:00"} 傳送總覽` : "✅ 已關閉每日總覽");
  } catch (err) { toast(err.message, true); }
  if (btn) btn.disabled = false;
});
$$("#setForm input[type=password]").forEach((i) => (i.dataset.ph = i.placeholder));

$("#setForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    await api("PUT", "/api/settings", body);
    toast("✅ 設定已儲存");
    META = await api("GET", "/api/meta");
    renderMeta();
    loadSettings();
  } catch (err) { toast(err.message, true); }
  if (btn) btn.disabled = false;
});

$("#testNotify").onclick = async () => {
  try {
    const r = await api("POST", "/api/settings/test-notify");
    toast(r.queued ? "已請 GitHub Actions 傳測試訊息，約 1 分鐘內會收到" : `✅ 已送出到 ${r.channels.join("、")}，請看手機`);
  } catch (err) { toast(err.message + "（若剛修改，請先按「儲存設定」）", true); }
};

$("#summaryNow").onclick = async () => {
  try {
    const r = await api("POST", "/api/settings/summary-now");
    toast(r.queued ? "已請 GitHub Actions 傳總覽，約 1 分鐘內會收到" : `✅ 總覽已送出到 ${r.channels.join("、")}`);
  } catch (err) { toast(err.message, true); }
};

$("#getChatId").onclick = async () => {
  const token = $("#setForm").elements.namedItem("telegram_bot_token").value.trim();
  try {
    const { chats } = await api("POST", "/api/settings/telegram-chat-id", { token });
    if (!chats.length) return toast("找不到訊息：請先在 Telegram 對你的 bot 傳任意一句話，再按一次", true);
    $("#setForm").elements.namedItem("telegram_chat_id").value = chats[0].id;
    toast(`已填入 ${chats[0].name || chats[0].id}，記得按「儲存設定」`);
  } catch (err) { toast(err.message, true); }
};

$("#pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("POST", "/api/password", Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    toast("✅ 密碼已設定");
    META = await api("GET", "/api/meta");
    renderMeta();
  } catch (err) { toast(err.message, true); }
});

$("#logout").onclick = async () => {
  await api("POST", "/api/logout");
  location.href = window.BACKEND?.loginUrl || "/login";
};

init().catch((err) => toast(err.message, true));
