const DEFAULTS = { bg: "#000", active: "#E0E0E0", cleared: "#555" };
const CODE_PH = 'Send("^c")|Sleep(50)|Send("^v")';
const CSS_VARS = { bg: "--bg", active: "--fg", cleared: "--dim" };
const $ = (id) => document.getElementById(id);
const rows = $("rows"), msg = $("msg"), optionsKeyInput = $("optionsKey");
const setupBox = $("setup"), dl = $("dl");
const SETUP_URL = "";   // helper download page; button hidden if empty
if (SETUP_URL) { dl.href = SETUP_URL; dl.hidden = false; }
const settingsBox = $("settings"), settingsBtn = $("settingsBtn");
const extrasBox = $("extras"), extrasBtn = $("extrasBtn");
const hexInputs = [...settingsBox.querySelectorAll("input[data-key]")];

let model = [];                       // { k: shortcut field, u: url }, incl. blank just-added rows (not written)
let optionsKey = "";
let settings = { ...DEFAULTS };
let loaded = false;                   // true only after a valid ini was loaded; nothing is written otherwise

// Serialize ini loads/writes
let q = Promise.resolve();
const run = (f) => (q = q.then(f).catch(e => { msg.textContent = e.message; }));

// ---- Ini I/O (background.js relays to the native helper) ----
// Resolves with the reply; throws Error(message) on failure, err.down = helper unreachable.
async function callHost(req) {
  let r;
  try { r = await browser.runtime.sendMessage({ host: req }); }
  catch (e) { r = { ok: false, down: true, error: e.message }; }
  if (!r || !r.ok) {
    const err = new Error((r && r.error) || "The helper returned an invalid reply.");
    err.down = !!(r && r.down);
    throw err;
  }
  return r;
}

async function persist() {
  if (!loaded) { msg.textContent = "No valid ini is loaded, so nothing was saved."; return; }
  try {
    await callHost({ cmd: "write", text: serializeIni(settings, optionsKey, model) });
  } catch (e) {
    msg.textContent = `Could not save the ini: ${e.message}`;
  }
}

function setLoaded(ok) {
  loaded = ok;
  for (const el of [$("add"), $("import"), $("restore-colors"), optionsKeyInput, ...hexInputs]) el.disabled = !ok;
  if (!ok) { model = []; optionsKey = ""; optionsKeyInput.value = ""; applySettings({ ...DEFAULTS }); build(); }
}

const fail = (t, down) => { setLoaded(false); msg.textContent = t; setupBox.hidden = !down; };

let pollT;
async function loadIni() {
  clearTimeout(pollT);
  msg.textContent = "";
  let res;
  try { res = await callHost({ cmd: "read" }); }
  catch (e) {
    fail(e.down ? `Helper unreachable: ${e.message}` : e.message, e.down);
    if (e.down) pollT = setTimeout(() => run(loadIni), 5000);
    return;
  }
  setupBox.hidden = true;
  const text = String(res.text || "");

  // Missing or blank file: start from an empty config and write the two variables
  if (!text.trim()) {
    setLoaded(true);
    model = []; optionsKey = ""; optionsKeyInput.value = "";
    applySettings({ ...DEFAULTS });
    build();
    await persist();
    return;
  }
  let parsed;
  try { parsed = parseIni(text); }
  catch (e) { return fail(`Invalid Firefox AHK Receiver.ini (left untouched): ${e.message}`); }

  setLoaded(true);
  model = parsed.rows;
  optionsKey = parsed.optionsKey || "";
  optionsKeyInput.value = optionsKey;
  applySettings(mergeSettings(parsed));
  build();
}

// ---- Rows ----
function build() {
  const tpl = $("row").content.firstElementChild;
  const frag = document.createDocumentFragment();
  model.forEach((r, i) => {
    const tr = tpl.cloneNode(true);
    tr.dataset.i = i;
    const f = (c) => tr.querySelector("." + c);
    f("url").value = r.u;
    f("key").value = r.k;
    f("type").value = r.t;
    f("url").placeholder = r.t === "code" ? CODE_PH : "example.com";
    f("pos").value = i + 1;
    f("pos").max = model.length;
    refresh(tr);
    frag.appendChild(tr);
  });
  rows.replaceChildren(frag);
}

// Row is "empty" (cleared color) when URL and shortcut are both blank
const refresh = (tr) =>
  tr.classList.toggle("empty", ![".url", ".key"].some(c => tr.querySelector(c).value.trim()));

// Move a row to index `to`, rebuild, refocus the same control
const go = (item, to, sel) => run(async () => {
  const from = model.indexOf(item);
  to = Math.max(0, Math.min(model.length - 1, to));
  if (from < 0) return;
  if (from === to) { rows.children[from].querySelector(".pos").value = from + 1; return; }
  model.splice(to, 0, ...model.splice(from, 1));
  build();
  rows.children[to].querySelector(sel).focus();
  await persist();
});

// Shortcut field: "hotkey [@ cond [& cond] [| cond & cond]] [_ hotkey ...]". Hotkey text is AHK syntax, stored as typed.
// Spaces around @ & | _ are optional; write \\@ \\& \\| \\_ for a literal character.
const SEP = /\s*(?<!\\)_+\s*/, AT = /^(.+?)\s*(?<!\\)@\s*(.+)$/, OR = /\s*(?<!\\)\|\s*/, AND = /\s*(?<!\\)&\s*/;
const unesc = (s) => s.replace(/\\([@&|_])/g, "$1");

// -> { text: whitespace-collapsed field, entries: [{ hk, cond, id }] }; strict throws Error on bad syntax
function parseField(s, strict = true) {
  const text = String(s || "").replace(/\s+/g, " ").trim();
  const entries = [];
  for (const raw of text.split(SEP).map(x => x.trim()).filter(Boolean)) {
    const m = AT.exec(raw);
    const hk = unesc(m ? m[1].trim() : raw), cond = m ? m[2].trim() : "";
    if (strict && m) {
      for (const alt of cond.split(OR)) for (const t of alt.split(AND))
        if (!/^(gks|gf):\S+$/i.test(t.trim())) throw new Error(`Invalid condition "${t.trim()}". Use gks:Key or gf:FlagName, joined with & / |.`);
    }
    entries.push({ hk, cond, id: `${hk}\0${cond}`.toLowerCase() });
  }
  return { text, entries };
}

// Validates a field for `item`; returns the normalized text or throws Error(message)
function checkField(v, item) {
  const { text, entries } = parseField(v);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`"${e.hk}" with the same conditions appears twice in this field.`);
    seen.add(e.id);
    const dup = model.findIndex(r => r !== item && parseField(r.k, false).entries.some(x => x.id === e.id));
    if (dup >= 0) throw new Error(`${e.hk} with the same conditions is already used by row ${dup + 1}.`);
    if (optionsKey && e.hk.toLowerCase() === optionsKey.toLowerCase()) throw new Error(`${e.hk} is already used by the Options shortcut.`);
  }
  return text;
}

rows.addEventListener("input", (e) => refresh(e.target.closest("tr")));

rows.addEventListener("change", (e) => {
  const el = e.target, tr = el.closest("tr"), item = model[+tr.dataset.i];
  if (!item) return;
  if (el.classList.contains("type")) run(() => {
    item.t = el.value;
    tr.querySelector(".url").placeholder = item.t === "code" ? CODE_PH : "example.com";
    return persist();
  });
  else if (el.classList.contains("url")) run(() => { item.u = el.value.trim(); return persist(); });
  else if (el.classList.contains("key")) run(async () => {
    msg.textContent = "";
    let k;
    try { k = checkField(el.value, item); }
    catch (err) { msg.textContent = err.message; el.value = item.k; refresh(tr); return; }
    el.value = k;
    refresh(tr);
    if (k === item.k) return;
    item.k = k;
    await persist();
  });
});

rows.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const i = +b.closest("tr").dataset.i, item = model[i];
  if (!item) return;
  if (b.classList.contains("up")) go(item, i - 1, ".up");
  else if (b.classList.contains("dn")) go(item, i + 1, ".dn");
  else if (b.classList.contains("rm")) run(async () => {
    const at = model.indexOf(item);
    if (at < 0) return;
    model.splice(at, 1);
    build();
    await persist();
    const next = rows.children[Math.min(at, model.length - 1)];
    (next ? next.querySelector(".rm") : $("add")).focus();
  });
});

rows.addEventListener("keydown", (e) => {
  const el = e.target;
  if (e.key !== "Enter" || !el.classList.contains("pos")) return;
  e.preventDefault();
  const i = +el.closest("tr").dataset.i, to = parseInt(el.value, 10);
  if (!to) el.value = i + 1; else go(model[i], to - 1, ".pos");
});

$("add").addEventListener("click", () => run(async () => {
  model.push({ k: "", u: "", t: "url" });
  build();
  rows.lastElementChild.querySelector(".key").focus();
}));

$("refreshBtn").addEventListener("click", () => run(loadIni));

// ---- Options shortcut ----
optionsKeyInput.addEventListener("change", () => run(async () => {
  msg.textContent = "";
  const v = optionsKeyInput.value.trim();
  const dup = v ? model.findIndex(r => parseField(r.k, false).entries.some(x => x.hk.toLowerCase() === v.toLowerCase())) : -1;
  if (dup >= 0) {
    msg.textContent = `${v} is already used by row ${dup + 1}.`;
    optionsKeyInput.value = optionsKey;
    return;
  }
  optionsKeyInput.value = v;
  if (v === optionsKey) return;
  optionsKey = v;
  await persist();
}));

// ---- Settings ----
function normalizeHex(s) {
  s = String(s || "").trim();
  if (s && s[0] !== "#") s = "#" + s;
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : null;
}
const mergeSettings = (raw = {}, base = DEFAULTS) =>
  Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, normalizeHex(raw[k]) || base[k]]));

function applySettings(s) {
  settings = s;
  for (const [k, v] of Object.entries(CSS_VARS)) document.documentElement.style.setProperty(v, s[k]);
  for (const inp of hexInputs) {
    inp.value = s[inp.dataset.key];
    inp.nextElementSibling.style.background = s[inp.dataset.key];
  }
}

async function updateSettings(s) {
  applySettings(s);
  await persist();
}

for (const inp of hexInputs) {
  inp.addEventListener("input", () => {
    const v = normalizeHex(inp.value);
    if (v) inp.nextElementSibling.style.background = v;
  });
  inp.addEventListener("change", () => run(async () => {
    msg.textContent = "";
    const v = normalizeHex(inp.value);
    if (!v) {
      msg.textContent = "Invalid color. Use hex like #000 or #E0E0E0.";
      applySettings(settings);
      return;
    }
    await updateSettings({ ...settings, [inp.dataset.key]: v });
  }));
}

$("restore-colors").addEventListener("click", () => run(() => {
  msg.textContent = "";
  return updateSettings({ ...DEFAULTS });
}));

// Collapsible panels: toggle the box and flip the arrow
function togglePanel(btn, box) {
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute("aria-expanded", open);
  btn.querySelector("span").textContent = open ? "▴" : "▸";
}
settingsBtn.addEventListener("click", () => togglePanel(settingsBtn, settingsBox));
extrasBtn.addEventListener("click", () => togglePanel(extrasBtn, extrasBox));

// ---- Backup ----
$("export").addEventListener("click", () => {
  const data = { version: 1, optionsKey, rows: model.filter(r => r.k || r.u), settings };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "ahk-receiver-backup.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  run(async () => {
    msg.textContent = "";
    try {
      const d = JSON.parse(await file.text());
      const raw = Array.isArray(d.rows) ? d.rows : [];
      // old backups kept conditions in r.c ("gks:F15, gf:X"); fold them into the shortcut field
      const next = raw.map(r => {
        const c = String(r?.c || "").split(",").map(x => x.trim()).filter(Boolean).join(" & ");
        const k = String(r?.k || "").trim();
        return { k: c && k ? `${k} @ ${c}` : k, u: String(r?.u || "").trim(), t: r?.t === "code" ? "code" : "url" };
      }).filter(r => r.k || r.u);
      const ok = (r) => { try { r.k = parseField(r.k).text; return true; } catch { return false; } };
      const skipped = next.filter(r => !ok(r)).length;
      model = next.filter(ok);
      if (typeof d.optionsKey === "string") {
        const k = d.optionsKey.trim();
        if (!k || !model.some(r => parseField(r.k, false).entries.some(x => x.hk.toLowerCase() === k.toLowerCase()))) { optionsKey = k; optionsKeyInput.value = k; }
      }
      if (d.settings) applySettings(mergeSettings(d.settings, settings));
      build();
      await persist();
      if (skipped) msg.textContent = `${skipped} shortcut(s) in the backup had invalid shortcut/condition syntax and were skipped.`;
    } catch (err) {
      msg.textContent = `Import failed: ${err.message}`;
    }
  });
});

(async () => {
  applySettings({ ...DEFAULTS });
  setLoaded(false);
  await run(loadIni);
})();
