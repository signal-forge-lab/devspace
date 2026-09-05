"use strict";

const net = require("node:net");

const DEFAULT_MONITOR_URL = "http://127.0.0.1:7677/monitor";
const MINIMUM_WIDTH = 960;
const MINIMUM_HEIGHT = 640;

function desktopMemorySnapshot(
  metrics,
  systemTotalBytes,
  systemFreeBytes,
  previousPeakWorkingSetBytes = null,
  sampledAt = Date.now(),
) {
  const processes = (Array.isArray(metrics) ? metrics : []).map((metric) => {
    const memory = metric?.memory && typeof metric.memory === "object" ? metric.memory : {};
    return {
      type: typeof metric?.type === "string" && metric.type.trim() ? metric.type.trim() : "Unknown",
      pid: Number.isInteger(metric?.pid) ? metric.pid : null,
      workingSetBytes: kibibytesToBytes(memory.workingSetSize),
      privateBytes: kibibytesToBytes(memory.privateBytes),
    };
  });
  const workingSetBytes = sumCompleteBytes(processes.map((process) => process.workingSetBytes));
  const privateBytes = sumCompleteBytes(processes.map((process) => process.privateBytes));
  const previousPeak = nonNegativeBytes(previousPeakWorkingSetBytes);
  const peakWorkingSetBytes = workingSetBytes === null
    ? previousPeak
    : Math.max(previousPeak ?? 0, workingSetBytes);
  const totalBytes = nonNegativeBytes(systemTotalBytes);
  const freeBytes = nonNegativeBytes(systemFreeBytes);
  const usedBytes = totalBytes !== null && freeBytes !== null && freeBytes <= totalBytes
    ? totalBytes - freeBytes
    : null;
  return {
    sampledAt: Number.isFinite(sampledAt) ? sampledAt : Date.now(),
    workingSetBytes,
    privateBytes,
    peakWorkingSetBytes,
    processes,
    system: { totalBytes, freeBytes, usedBytes },
  };
}

function kibibytesToBytes(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1024)
    : null;
}

function nonNegativeBytes(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function sumCompleteBytes(values) {
  return values.length && values.every((value) => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

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
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("Workbridge monitor URL must use a loopback hostname.");
  }
  parsed.hash = "";
  if (parsed.pathname === "/") parsed.pathname = "/monitor";
  return parsed.toString().replace(/\/$/, "");
}

function isLoopbackHostname(value) {
  const normalized = String(value).trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.startsWith("127.");
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
.card{width:min(720px,calc(100vw - 48px));padding:30px;border:1px solid #263546;border-radius:16px;background:rgba(17,25,35,.96);box-shadow:0 22px 70px rgba(0,0,0,.35)}
.brand{display:flex;align-items:center;gap:14px}.brand-icon{width:48px;height:48px;object-fit:contain}.mark{color:#32a8ff;font-size:34px;font-weight:900;transform:skew(-8deg)}h1{font-size:21px;margin:0}.status{display:flex;align-items:center;gap:10px;margin-top:22px;color:#c4d0db}.dot{width:9px;height:9px;border-radius:50%;background:#f7b42c;box-shadow:0 0 12px rgba(247,180,44,.65);animation:pulse 1.4s infinite}.reason{margin-top:9px;color:#8fa0b2;font-size:13px;line-height:1.6}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.controls button,.config-actions button{border:1px solid #30475e;border-radius:7px;background:#14202c;color:#c9d7e3;padding:7px 11px;cursor:pointer}.controls button.primary,.config-actions button.primary{border-color:#2389cf;background:#123a56;color:#eaf7ff}.controls button:disabled,.config-actions button:disabled{opacity:.45;cursor:not-allowed}.operation{min-height:18px;margin-top:10px;color:#8fa0b2;font:11px/1.5 ui-monospace,Consolas,monospace}
.config{margin-top:18px;padding:14px;border:1px solid #263546;border-radius:10px;background:#0a1118}.config-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.config-head strong{font-size:12px}.config-state{color:#8fa0b2;font:10px ui-monospace,Consolas,monospace}.config-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;margin-top:12px}.field{display:grid;gap:4px;color:#8296aa;font-size:9px}.field input:not([type="checkbox"]),.field textarea{width:100%;border:1px solid #2b4053;border-radius:6px;background:#0d1720;color:#d8e4ed;padding:7px 8px;font:10px/15px ui-monospace,Consolas,monospace;resize:vertical}.proxy{display:flex;align-items:center;justify-content:flex-start;gap:7px;min-height:34px;color:#b2c0cc;font-size:10px;white-space:nowrap}.proxy input{width:auto;flex:0 0 auto;margin:0;accent-color:#32a8ff}.config-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px}.url{margin-top:16px;padding:10px 12px;border:1px solid #263546;border-radius:8px;background:#0a1017;color:#73c9ff;font:12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.note{margin-top:12px;color:#667b8f;font-size:11px}@keyframes pulse{0%,100%{opacity:.45;transform:scale(.82)}50%{opacity:1;transform:scale(1.2)}}@media(max-width:680px){.config-grid{grid-template-columns:1fr}}</style></head>
<body><main class="card"><div class="brand">${brandIcon}<div><h1>Workbridge Monitor</h1></div></div><div class="status"><span class="dot"></span><strong id="state-label">状態確認中</strong></div><div class="reason">${safeReason}</div><div class="controls"><button class="primary" data-action="start">Start</button><button data-action="build">Build</button><button data-action="build-restart">Build & Restart</button><button data-action="pause">Pause</button></div><div id="operation" class="operation"></div><form id="startup-form" class="config"><div class="config-head"><strong>Startup Config</strong><span id="config-state" class="config-state">確認中</span></div><div class="config-grid"><label class="field"><span>Public Base URL</span><input id="public-url" type="url" autocomplete="off" spellcheck="false"></label><label class="field"><span>State Directory</span><input id="state-dir" type="text" autocomplete="off" spellcheck="false"></label><label class="field"><span>Project Roots（1行に1パス）</span><textarea id="allowed-roots" rows="2" spellcheck="false"></textarea></label><label class="field"><span>Auxiliary Roots（1行に1パス）</span><textarea id="auxiliary-roots" rows="2" spellcheck="false"></textarea></label><label class="field"><span>Managed Worktree Root</span><input id="worktree-root" type="text" autocomplete="off" spellcheck="false"></label><label class="field"><span>Proxy</span><span class="proxy"><input id="trust-proxy" type="checkbox">Trust Proxyを有効にする</span></label></div><div class="config-actions"><button id="save-config" class="primary" type="submit">Save Config</button></div></form><div class="url">${safeUrl}</div><div class="note">Startup Configを保存してStartすると、接続可能になった時点で自動的にセッションモニターへ切り替わります。Soft Pauseは起動時に自動解除されます。</div></main><script>
const api=window.workbridgeDesktop,buttons=[...document.querySelectorAll('[data-action]')],label=document.getElementById('state-label'),operation=document.getElementById('operation'),form=document.getElementById('startup-form'),configState=document.getElementById('config-state'),publicUrl=document.getElementById('public-url'),allowedRoots=document.getElementById('allowed-roots'),auxiliaryRoots=document.getElementById('auxiliary-roots'),worktreeRoot=document.getElementById('worktree-root'),stateDir=document.getElementById('state-dir'),trustProxy=document.getElementById('trust-proxy'),saveConfig=document.getElementById('save-config');
const stateLabels={starting:'起動中',stopped:'停止中',building:'ビルド中',stopping:'停止中',restarting:'再起動中',pausing:'一時停止中',resuming:'再開中',working:'処理中'};let dirty=false,loaded=false;
function populate(config){if(dirty||loaded)return;publicUrl.value=config?.publicBaseUrl||'';allowedRoots.value=Array.isArray(config?.allowedRoots)?config.allowedRoots.join('\\n'):'';auxiliaryRoots.value=Array.isArray(config?.auxiliaryRoots)?config.auxiliaryRoots.join('\\n'):'';worktreeRoot.value=config?.worktreeRoot||'';stateDir.value=config?.stateDir||'';trustProxy.checked=config?.trustProxy===true;loaded=true}
function render(status){if(!status)return;const visibleState=status.state==='starting'&&!Number.isInteger(status.managedPid)?'stopped':status.state;label.textContent=stateLabels[visibleState]||visibleState;populate(status.startupConfig);configState.textContent=status.startupConfigComplete?(dirty?'未保存':'保存済み'):'設定が必要です';const busy=Boolean(status.operation&&status.operation.active),startedAt=status.operation?.startedAt,elapsed=busy&&Number.isFinite(startedAt)?Math.max(0,Math.floor((Date.now()-startedAt)/1000)):undefined,line=status.operation?.line||status.lastResult?.error||status.lastResult?.line||'';buttons.forEach(button=>{const action=button.dataset.action;const cap=action==='build-restart'?'buildRestart':action;button.disabled=busy||status.capabilities?.[cap]===false});saveConfig.disabled=busy||!dirty;operation.textContent=elapsed===undefined?line:(line?line+' · 経過 '+elapsed+'秒':'経過 '+elapsed+'秒')}
for(const field of [publicUrl,allowedRoots,auxiliaryRoots,worktreeRoot,stateDir,trustProxy])field.addEventListener('input',()=>{dirty=true;saveConfig.disabled=false;configState.textContent='未保存'});
if(api){api.getStatus().then(render);api.onStatus(render);buttons.forEach(button=>button.addEventListener('click',async()=>{try{await api.runAction(button.dataset.action)}catch(error){operation.textContent=error?.message||String(error)}}));form.addEventListener('submit',async event=>{event.preventDefault();try{const status=await api.saveStartupConfig({publicBaseUrl:publicUrl.value.trim(),allowedRoots:allowedRoots.value.split(/\\r?\\n|,/).map(value=>value.trim()).filter(Boolean),auxiliaryRoots:auxiliaryRoots.value.split(/\\r?\\n|,/).map(value=>value.trim()).filter(Boolean),worktreeRoot:worktreeRoot.value.trim(),stateDir:stateDir.value.trim(),trustProxy:trustProxy.checked});dirty=false;loaded=false;operation.textContent='Startup Configを保存しました。';render(status)}catch(error){operation.textContent=error?.message||String(error)}})}else{buttons.forEach(button=>button.disabled=true);saveConfig.disabled=true;operation.textContent='Desktop controls unavailable'}</script></body></html>`;
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
  desktopMemorySnapshot,
  isAllowedMonitorNavigation,
  normalizeWindowState,
  resolveMonitorUrl,
  waitingPageHtml,
  windowStateIsVisible,
};
