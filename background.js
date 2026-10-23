const HOST = "ahk_receiver";
const RETRY_MS = 15000;
let port = null, nextId = 1, retryT;
const pending = new Map();

function connect() {
  if (port) return;
  clearTimeout(retryT);
  let p;
  try { p = browser.runtime.connectNative(HOST); }
  catch (e) { retryT = setTimeout(connect, RETRY_MS); return; }
  port = p;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    const err = new Error((p.error && p.error.message) || "Helper disconnected.");
    if (port === p) port = null;
    for (const r of pending.values()) r.reject(err);
    pending.clear();
    retryT = setTimeout(connect, RETRY_MS);
  });
}

function openUrl(u) {
  u = String(u || "").trim();
  if (!u) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  browser.tabs.create({ url: u, active: true }).catch(() => {});
}

function onHostMessage(m) {
  if (!m) return;
  if (m.id != null) {
    const r = pending.get(m.id);
    if (r) { pending.delete(m.id); r.resolve(m); }
  } else if (m.cmd === "open") openUrl(m.url);
  else if (m.cmd === "options") openOptions();
  else if (m.cmd === "focusnew") focusNewUntil = Date.now() + 3000;
}

// Tabs opened by the helper via command line (about: etc.) open in the background; activate the next new tab
let focusNewUntil = 0;
browser.tabs.onCreated.addListener((tab) => {
  if (Date.now() > focusNewUntil) return;
  focusNewUntil = 0;
  browser.tabs.update(tab.id, { active: true }).catch(() => {});
  browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
});

async function openOptions() {
  try { await browser.runtime.openOptionsPage(); }
  catch (e) {
    console.error("openOptionsPage failed:", e);
    browser.tabs.create({ url: browser.runtime.getURL("options.html"), active: true }).catch(console.error);
  }
}

function request(req) {
  connect();
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error("Helper not running."));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Helper did not answer.")); }, 5000);
    pending.set(id, {
      resolve: (m) => { clearTimeout(timer); resolve(m); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    try { port.postMessage({ id, ...req }); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

browser.runtime.onMessage.addListener((m) => {
  if (m && m.host) return request(m.host).catch((e) => ({ ok: false, down: true, error: e.message }));
});

connect();
