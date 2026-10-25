const DEFAULTS = { bg: "#000", active: "#E0E0E0", cleared: "#555" };
const POP_DEFAULTS = { sel: "lbutton_space_enter", close: "Esc", pos: "cursor" };
const POP_POS = ["center", "cursor", "viewport"];
const CODE_PH = 'Send("^c")|Sleep(50)|Send("^v")';
const PH = { url: "example.com", code: CODE_PH, popup: "Popup name" };
const CSS_VARS = { bg: "--bg", active: "--fg", cleared: "--dim" };
const $ = (id) => document.getElementById(id);
const main = $("main"), rows = $("rows"), subsBox = $("subs"), msg = $("msg"), optionsKeyInput = $("optionsKey");
const setupBox = $("setup"), dl = $("dl");
const SETUP_URL = "";   // helper download page; button hidden if empty
if (SETUP_URL) { dl.href = SETUP_URL; dl.hidden = false; }
const settingsBox = $("settings"), settingsBtn = $("settingsBtn");
const extrasBox = $("extras"), extrasBtn = $("extrasBtn");
const hexInputs = [...settingsBox.querySelectorAll("input[data-key]")];
const popInputs = [...settingsBox.querySelectorAll("[data-pop]")];

let model = [];                       // { k: shortcut field, u: url/code/popup name, t, s? (popup sub rows) }, incl. blank just-added rows (not written)
let optionsKey = "";
let settings = { ...DEFAULTS };
let popKeys = { ...POP_DEFAULTS };
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
    await callHost({ cmd: "write", text: serializeIni(settings, optionsKey, model, popKeys) });
  } catch (e) {
    msg.textContent = `Could not save the ini: ${e.message}`;
  }
}

function setLoaded(ok) {
  loaded = ok;
  for (const el of [$("add"), $("import"), $("restore-colors"), optionsKeyInput, ...hexInputs, ...popInputs]) el.disabled = !ok;
  if (!ok) { model = []; optionsKey = ""; optionsKeyInput.value = ""; applyPop({}); applySettings({ ...DEFAULTS }); build(); }
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
    applyPop({});
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
  applyPop({ sel: parsed.popSel, close: parsed.popClose, pos: parsed.popPos });
  applySettings(mergeSettings(parsed));
  build();
}

// ---- Rows ----
const blank = () => ({ k: "", u: "", t: "url" });
const listOf = (tr) => tr.dataset.s === "" ? model : model[+tr.dataset.s].s;
const rowEl = (si, i) => main.querySelector(`tr[data-s="${si}"][data-i="${i}"]`);

// si = "" for main rows, else the index of the owning popup row
function makeRow(r, i, si, len) {
  const tr = $("row").content.firstElementChild.cloneNode(true);
  tr.dataset.i = i;
  tr.dataset.s = si;
  const f = (c) => tr.querySelector("." + c);
  if (si !== "") f("type").querySelector('option[value="popup"]').remove();   // no nested popups
  f("url").value = r.u;
  f("key").value = r.k;
  f("type").value = r.t;
  f("url").placeholder = PH[r.t];
  f("pos").value = i + 1;
  f("pos").max = len;
  refresh(tr);
  return tr;
}

function build() {
  rows.replaceChildren(...model.map((r, i) => makeRow(r, i, "", model.length)));
  const secs = [];
  model.forEach((p, si) => {
    if (p.t !== "popup") return;
    if (!p.s) p.s = [];
    const sec = $("sub").content.firstElementChild.cloneNode(true);
    sec.dataset.s = si;
    sec.querySelector("b").textContent = p.u || "(unnamed)";
    sec.querySelector("tbody").replaceChildren(...p.s.map((r, i) => makeRow(r, i, si, p.s.length)));
    secs.push(sec);
  });
  subsBox.replaceChildren(...secs);
}

// Row is "empty" (cleared color) when URL and shortcut are both blank
const refresh = (tr) =>
  tr.classList.toggle("empty", ![".url", ".key"].some(c => tr.querySelector(c).value.trim()));

// Move a row to index `to` within its list, rebuild, refocus the same control
const go = (list, si, item, to, sel) => run(async () => {
  const from = list.indexOf(item);
  to = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0) return;
  if (from === to) { rowEl(si, from).querySelector(".pos").value = from + 1; return; }
  list.splice(to, 0, ...list.splice(from, 1));
  build();
  rowEl(si, to).querySelector(sel).focus();
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

// Validates a field for `item` within `list` (sub = popup sub table); returns the normalized text or throws Error(message)
function checkField(v, item, list, sub) {
  const { text, entries } = parseField(v);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`"${e.hk}" with the same conditions appears twice in this field.`);
    seen.add(e.id);
    const dup = list.findIndex(r => r !== item && parseField(r.k, false).entries.some(x => x.id === e.id));
    if (dup >= 0) throw new Error(`${e.hk} with the same conditions is already used by row ${dup + 1}${sub ? " of this popup" : ""}.`);
    const lc = e.hk.toLowerCase();
    if (!sub && optionsKey && lc === optionsKey.toLowerCase()) throw new Error(`${e.hk} is already used by the Options shortcut.`);
    if (sub && [popKeys.sel, popKeys.close].some(f => parseField(f, false).entries.some(x => x.id === e.id))) throw new Error(`${e.hk} with the same conditions is already used as a popup select/close key.`);
  }
  return text;
}

// Popup names link a P row to its sub table in the ini
function checkName(v, item) {
  if (/[\[\]\t]/.test(v)) throw new Error("Popup names cannot contain [ ] or tabs.");
  const dup = v ? model.findIndex(r => r !== item && r.t === "popup" && r.u.toLowerCase() === v.toLowerCase()) : -1;
  if (dup >= 0) throw new Error(`Popup name "${v}" is already used by row ${dup + 1}.`);
}

main.addEventListener("input", (e) => { const tr = e.target.closest("tr"); if (tr) refresh(tr); });

main.addEventListener("change", (e) => {
  const el = e.target, tr = el.closest("tr");
  if (!tr || tr.dataset.i === undefined) return;
  const list = listOf(tr), item = list[+tr.dataset.i], sub = tr.dataset.s !== "";
  if (!item) return;
  if (el.classList.contains("type")) run(async () => {
    msg.textContent = "";
    const t = el.value, was = item.t;
    if (t === "popup") {
      try { checkName(item.u, item); }
      catch (err) { msg.textContent = err.message; el.value = was; return; }
      if (!item.s) item.s = [];
    }
    item.t = t;
    if (t === "popup" || was === "popup") build();
    else tr.querySelector(".url").placeholder = PH[t];
    await persist();
  });
  else if (el.classList.contains("url")) run(async () => {
    msg.textContent = "";
    const v = el.value.trim();
    if (item.t === "popup") {
      try { checkName(v, item); }
      catch (err) { msg.textContent = err.message; el.value = item.u; return; }
      const sec = subsBox.querySelector(`section[data-s="${tr.dataset.i}"] b`);
      if (sec) sec.textContent = v || "(unnamed)";
    }
    el.value = v;
    item.u = v;
    await persist();
  });
  else if (el.classList.contains("key")) run(async () => {
    msg.textContent = "";
    let k;
    try { k = checkField(el.value, item, list, sub); }
    catch (err) { msg.textContent = err.message; el.value = item.k; refresh(tr); return; }
    el.value = k;
    refresh(tr);
    if (k === item.k) return;
    item.k = k;
    await persist();
  });
});

main.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.classList.contains("sadd")) {
    const si = b.closest("section").dataset.s, p = model[+si];
    if (p) run(async () => {
      p.s.push(blank());
      build();
      rowEl(si, p.s.length - 1).querySelector(".key").focus();
    });
    return;
  }
  const tr = b.closest("tr");
  if (!tr || tr.dataset.i === undefined) return;
  const list = listOf(tr), si = tr.dataset.s, i = +tr.dataset.i, item = list[i];
  if (!item) return;
  if (b.classList.contains("up")) go(list, si, item, i - 1, ".up");
  else if (b.classList.contains("dn")) go(list, si, item, i + 1, ".dn");
  else if (b.classList.contains("rm")) run(async () => {
    const at = list.indexOf(item);
    if (at < 0) return;
    list.splice(at, 1);
    build();
    await persist();
    const next = rowEl(si, Math.min(at, list.length - 1));
    (next ? next.querySelector(".rm") : $("add")).focus();
  });
});

main.addEventListener("keydown", (e) => {
  const el = e.target;
  if (e.key !== "Enter" || !el.classList.contains("pos")) return;
  e.preventDefault();
  const tr = el.closest("tr"), list = listOf(tr), i = +tr.dataset.i, to = parseInt(el.value, 10);
  if (!to) el.value = i + 1; else go(list, tr.dataset.s, list[i], to - 1, ".pos");
});

$("add").addEventListener("click", () => run(async () => {
  model.push(blank());
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

function applyPop(p) {
  popKeys = { sel: p.sel || POP_DEFAULTS.sel, close: p.close || POP_DEFAULTS.close, pos: POP_POS.includes(p.pos) ? p.pos : POP_DEFAULTS.pos };
  for (const inp of popInputs) inp.value = popKeys[inp.dataset.pop];
}

// Popup select/close use the same field syntax as the Shortcut column (several hotkeys, @ conditions).
// Returns the normalized text or throws Error(message)
function checkPopKey(which, v) {
  const { text, entries } = parseField(v);
  if (!entries.length) throw new Error("Popup keys cannot be empty.");
  const otherName = which === "sel" ? "close" : "sel";
  const other = parseField(popKeys[otherName], false).entries;
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) throw new Error(`"${e.hk}" with the same conditions appears twice in this field.`);
    seen.add(e.id);
    if (other.some(x => x.id === e.id)) throw new Error(`${e.hk} with the same conditions is already used as the popup ${otherName === "sel" ? "select" : "close"} key.`);
    const hit = model.find(r => r.t === "popup" && (r.s || []).some(x => parseField(x.k, false).entries.some(y => y.id === e.id)));
    if (hit) throw new Error(`${e.hk} with the same conditions is already used by a shortcut in popup "${hit.u}".`);
  }
  return text;
}

for (const inp of popInputs) {
  inp.addEventListener("change", () => run(async () => {
    msg.textContent = "";
    const which = inp.dataset.pop, v = inp.value.trim();
    if (which === "pos") { popKeys = { ...popKeys, pos: v }; await persist(); return; }
    let k;
    try { k = checkPopKey(which, v); }
    catch (err) { msg.textContent = err.message; inp.value = popKeys[which]; return; }
    inp.value = k;
    if (k === popKeys[which]) return;
    popKeys = { ...popKeys, [which]: k };
    await persist();
  }));
}

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
  const data = { version: 1, optionsKey, popKeys, rows: model.filter(r => r.k || r.u), settings };
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
      let skipped = 0;
      const names = new Set();
      // old backups kept conditions in r.c ("gks:F15, gf:X"); fold them into the shortcut field
      const norm = (r, sub) => {
        const c = String(r?.c || "").split(",").map(x => x.trim()).filter(Boolean).join(" & ");
        const k = String(r?.k || "").trim();
        const t = r?.t === "code" ? "code" : !sub && r?.t === "popup" ? "popup" : "url";
        const o = { k: c && k ? `${k} @ ${c}` : k, u: String(r?.u || "").trim(), t };
        if (t === "popup") o.s = (Array.isArray(r.s) ? r.s : []).map(x => norm(x, true)).filter(x => x.k || x.u);
        return o;
      };
      const ok = (r) => {
        try {
          r.k = parseField(r.k).text;
          if (r.t === "popup") {
            if (/[\[\]\t]/.test(r.u) || names.has(r.u.toLowerCase())) throw 0;
            names.add(r.u.toLowerCase());
            r.s = r.s.filter(x => (ok(x) || (skipped++, false)));
          }
          return true;
        } catch { return false; }
      };
      model = raw.map(r => norm(r, false)).filter(r => r.k || r.u).filter(r => ok(r) || (skipped++, false));
      if (typeof d.optionsKey === "string") {
        const k = d.optionsKey.trim();
        if (!k || !model.some(r => parseField(r.k, false).entries.some(x => x.hk.toLowerCase() === k.toLowerCase()))) { optionsKey = k; optionsKeyInput.value = k; }
      }
      if (d.settings) applySettings(mergeSettings(d.settings, settings));
      const goodField = (s) => { try { const f = parseField(String(s || "")); return f.entries.length ? f.text : ""; } catch { return ""; } };   // invalid -> default
      if (d.popKeys) applyPop({ sel: goodField(d.popKeys.sel), close: goodField(d.popKeys.close), pos: d.popKeys.pos });
      build();
      await persist();
      if (skipped) msg.textContent = `${skipped} shortcut(s) in the backup had invalid syntax (shortcut, conditions or popup name) and were skipped.`;
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
