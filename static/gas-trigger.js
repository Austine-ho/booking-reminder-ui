/**
 * 訂票監控：準時觸發器（Google Apps Script，免費）
 *
 * 為什麼需要：GitHub 內建的定時排程在尖峰時段常常延遲好幾小時、甚至被略過。
 * 這支程式每 10 分鐘看一次 state.json，「有網站到了檢查時間」才請 GitHub Actions 執行，
 * 所以檢查會準時（最多晚 10 分鐘），而且不浪費 GitHub 的免費分鐘數。
 *
 * 設定方式（約 5 分鐘）：
 * 1. 打開 https://script.google.com → 新專案，把這整個檔案貼上（取代原本內容），儲存
 * 2. 左側「專案設定」→ 最下面「指令碼屬性」新增：
 *      GITHUB_TOKEN = 新建一組 Fine-grained token（只勾這個 repo；權限：Actions 讀寫、Contents 唯讀）
 *      REPO         = Austine-ho/booking-reminder
 *      SUMMARY_TIME = 23:00（選填；每日總覽時間，要和網站設定一致）
 * 3. 上方函式選「setup」→ 按「執行」→ 依指示授權（只需要「連線到外部服務」）
 * 4. 選「tick」→ 執行一次，下方記錄顯示「沒有到時間的項目」或「已觸發」就完成了
 */

const TZ = "Asia/Taipei";
const MIN_GAP_MIN = 12;        // 觸發後至少隔幾分鐘才會再觸發（等上一輪跑完）

function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("tick").timeBased().everyMinutes(10).create();
  Logger.log("已設定：每 10 分鐘檢查一次");
}

function tick() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GITHUB_TOKEN"), repo = props.getProperty("REPO");
  if (!token || !repo) throw new Error("請先在「專案設定 → 指令碼屬性」填 GITHUB_TOKEN 與 REPO");
  const now = new Date();
  const reason = dueReason_(gh_(token, "GET", `/repos/${repo}/contents/watches.yaml`), gh_(token, "GET", `/repos/${repo}/contents/state.json`),
    props, now);
  if (!reason) { Logger.log("沒有到時間的項目"); return "idle"; }
  const last = Number(props.getProperty("LAST_DISPATCH") || 0);
  if (now.getTime() - last < MIN_GAP_MIN * 60000) { Logger.log("剛觸發過，等上一輪跑完"); return "wait"; }
  const branch = gh_(token, "GET", `/repos/${repo}`).json.default_branch || "main";
  const r = gh_(token, "POST", `/repos/${repo}/actions/workflows/monitor.yml/dispatches`, { ref: branch, inputs: { action: "check" } });
  if (r.code !== 204) throw new Error(`觸發失敗 ${r.code}：${r.text}`);
  props.setProperty("LAST_DISPATCH", String(now.getTime()));
  Logger.log("已觸發 GitHub Actions：" + reason);
  return "dispatched";
}

/** 回傳觸發原因；不需要觸發時回傳空字串。 */
function dueReason_(yamlRes, stateRes, props, now) {
  // 1) 網頁新增或修改了需求（watches.yaml 變了）→ 馬上跑一次，建立排程
  const yamlSha = yamlRes.code === 200 ? yamlRes.json.sha : "";
  if (yamlSha && yamlSha !== props.getProperty("LAST_YAML_SHA")) {
    props.setProperty("LAST_YAML_SHA", yamlSha);
    return "需求清單有變動";
  }
  const state = stateRes.code === 200 ? JSON.parse(decode_(stateRes.json.content)) : {};
  // 2) 有網站到了下次檢查時間（或通知送失敗等重送）
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("_") || k.startsWith("req:") || !v || typeof v !== "object") continue;
    if (v.status === "opened" || v.status === "expired") continue;
    if (v.notify_failed) return `${k} 通知待重送`;
    if (v.next_check && Date.parse(v.next_check) <= now.getTime()) return `${k} 到了檢查時間`;
  }
  // 3) 每日總覽時間到了、今天還沒送
  const sumTime = props.getProperty("SUMMARY_TIME");
  if (sumTime) {
    const today = Utilities.formatDate(now, TZ, "yyyy-MM-dd"), hm = Utilities.formatDate(now, TZ, "HH:mm");
    if (hm >= sumTime && (state._summary || {}).last !== today) return "每日總覽時間";
  }
  return "";
}

function gh_(token, method, path, body) {
  const res = UrlFetchApp.fetch("https://api.github.com" + path, {
    method: method.toLowerCase(), muteHttpExceptions: true, contentType: "application/json",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    payload: body ? JSON.stringify(body) : undefined,
  });
  const text = res.getContentText();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { /* 非 JSON */ }
  if (res.getResponseCode() === 401) throw new Error("GITHUB_TOKEN 無效或過期，請重新建立");
  return { code: res.getResponseCode(), json, text };
}

function decode_(b64) {
  return Utilities.newBlob(Utilities.base64Decode(b64.replace(/\n/g, ""))).getDataAsString("UTF-8");
}

if (typeof module !== "undefined") module.exports = { tick, dueReason_, setup };   // 本機測試用
