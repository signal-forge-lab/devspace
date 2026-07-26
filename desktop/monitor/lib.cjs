"use strict";

const DEFAULT_MONITOR_URL = "http://127.0.0.1:7676/monitor";
const MINIMUM_WIDTH = 960;
const MINIMUM_HEIGHT = 640;

function resolveMonitorUrl(value) {
  const candidate = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_MONITOR_URL;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Workbridge monitor URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Workbridge monitor URL must not include credentials.");
  }
  parsed.hash = "";
  if (parsed.pathname === "/") parsed.pathname = "/monitor";
  return parsed.toString().replace(/\/$/, "");
}

function isAllowedMonitorNavigation(target, monitorUrl) {
  try {
    const expected = new URL(monitorUrl);
    const candidate = new URL(target);
    return candidate.origin === expected.origin
      && (candidate.pathname === "/monitor" || candidate.pathname === "/monitor/");
  } catch {
    return false;
  }
}

function normalizeWindowState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const width = finiteInteger(value.width);
  const height = finiteInteger(value.height);
  if (width === undefined || height === undefined) return undefined;
  return {
    width: Math.max(MINIMUM_WIDTH, width),
    height: Math.max(MINIMUM_HEIGHT, height),
    x: finiteInteger(value.x),
    y: finiteInteger(value.y),
    maximized: value.maximized === true,
  };
}

function windowStateIsVisible(state, displays) {
  if (!state || state.x === undefined || state.y === undefined) return false;
  return displays.some((display) => {
    const area = display?.workArea;
    if (!area) return false;
    const overlapWidth = Math.max(
      0,
      Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y),
    );
    return overlapWidth >= 120 && overlapHeight >= 80;
  });
}

function waitingPageHtml(monitorUrl, reason, iconDataUrl) {
  const safeUrl = escapeHtml(monitorUrl);
  const safeReason = escapeHtml(reason || "Workbridgeの起動を待っています。");
  const safeIcon = typeof iconDataUrl === "string" && iconDataUrl.startsWith("data:image/")
    ? escapeHtml(iconDataUrl)
    : undefined;
  const brandIcon = safeIcon
    ? `<img class="brand-icon" src="${safeIcon}" alt="">`
    : `<div class="mark">W</div>`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Workbridge Monitor</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1016;color:#eef4fa}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 25% 0,#15304a 0,transparent 38%),#0b1016}
.card{width:min(560px,calc(100vw - 48px));padding:34px;border:1px solid #263546;border-radius:16px;background:rgba(17,25,35,.96);box-shadow:0 22px 70px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:14px}.brand-icon{width:48px;height:48px;object-fit:contain}.mark{color:#32a8ff;font-size:34px;font-weight:900;transform:skew(-8deg)}h1{font-size:21px;margin:0}.status{display:flex;align-items:center;gap:10px;margin-top:26px;color:#c4d0db}.dot{width:9px;height:9px;border-radius:50%;background:#f7b42c;box-shadow:0 0 12px rgba(247,180,44,.65);animation:pulse 1.4s infinite}.reason{margin-top:11px;color:#8fa0b2;font-size:13px;line-height:1.6}.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.controls button{border:1px solid #30475e;border-radius:7px;background:#14202c;color:#c9d7e3;padding:7px 11px;cursor:pointer}.controls button.primary{border-color:#2389cf;background:#123a56;color:#eaf7ff}.controls button:disabled{opacity:.45;cursor:not-allowed}.operation{min-height:18px;margin-top:12px;color:#8fa0b2;font:11px/1.5 ui-monospace,Consolas,monospace}.url{margin-top:20px;padding:10px 12px;border:1px solid #263546;border-radius:8px;background:#0a1017;color:#73c9ff;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.note{margin-top:14px;color:#667b8f;font-size:11px}@keyframes pulse{0%,100%{opacity:.45;transform:scale(.82)}50%{opacity:1;transform:scale(1.2)}}</style></head>
<body><main class="card"><div class="brand">${brandIcon}<div><h1>Workbridge Monitor</h1></div></div><div class="status"><span class="dot"></span><strong id="state-label">接続待機中</strong></div><div class="reason">${safeReason}</div><div class="controls"><button class="primary" data-action="start">Start</button><button data-action="build">Build</button><button data-action="build-restart">Build & Restart</button><button data-action="pause">Pause</button><button data-action="resume">Resume</button></div><div id="operation" class="operation"></div><div class="url">${safeUrl}</div><div class="note">接続可能になると、このウィンドウ内で自動的にモニターへ切り替わります。</div></main><script>
const api=window.workbridgeDesktop,buttons=[...document.querySelectorAll('[data-action]')],label=document.getElementById('state-label'),operation=document.getElementById('operation');
function render(status){if(!status)return;label.textContent=status.state==='stopped'?'停止中':status.state;const busy=Boolean(status.operation&&status.operation.active);buttons.forEach(button=>{const action=button.dataset.action;const cap=action==='build-restart'?'buildRestart':action;button.disabled=busy||status.capabilities?.[cap]===false});operation.textContent=status.operation?.line||status.lastResult?.error||status.lastResult?.line||''}
if(api){api.getStatus().then(render);api.onStatus(render);buttons.forEach(button=>button.addEventListener('click',async()=>{try{await api.runAction(button.dataset.action)}catch(error){operation.textContent=error?.message||String(error)}}))}else{buttons.forEach(button=>button.disabled=true);operation.textContent='Desktop controls unavailable'}</script></body></html>`;
}

function finiteInteger(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : undefined;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  DEFAULT_MONITOR_URL,
  MINIMUM_HEIGHT,
  MINIMUM_WIDTH,
  isAllowedMonitorNavigation,
  normalizeWindowState,
  resolveMonitorUrl,
  waitingPageHtml,
  windowStateIsVisible,
};
