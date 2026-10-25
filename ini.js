// Parsing/serializing "Firefox AHK Receiver.ini":
//   background = #000
//   active_font = #E0E0E0
//   cleared_font = #555
//   options_key = <ahk hotkey>
//   popup_select = <shortcut field>   (default LButton; same syntax as list shortcuts)
//   popup_close = <shortcut field>    (default Escape)
//   popup_position = center | cursor | viewport   (default center)
//   list = "
//   (
//   <shortcut field><TAB><url, {ahk code} with | as line break, or [popup name]>
//   (legacy lines "<hotkey>:<url>" and "<hotkey>|<conditions>|<url>" are read and converted)
//   )"
//   popups = "
//   (
//   [popup name]   (an unnamed popup is written as [<its shortcut>], and read back as unnamed)
//   <shortcut field, or _ for none><TAB><url or {ahk code}>
//   )"
// Mirrors how Firefox AHK Receiver.ahk reads it, but strict, so odd files are reported, not rewritten.
// Only "list" is required; missing optional keys fall back to defaults.

const mkRow = (k, u, sub) => /^\{.*\}$/.test(u) ? { k, u: u.slice(1, -1).trim(), t: "code" }
  : !sub && /^\[[^\[\]]+\]$/.test(u) ? { k, u: u.slice(1, -1).trim(), t: "popup", s: [] }
  : { k, u, t: "url" };
const SCALARS = { background: "bg", active_font: "active", cleared_font: "cleared", options_key: "optionsKey", popup_select: "popSel", popup_close: "popClose", popup_position: "popPos" };

// Index of the "(" line opening the block that starts at line i
function blockStart(lines, i, name) {
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j >= lines.length || lines[j].trim() !== "(") throw new Error(`Line ${i + 1}: expected "(" on the line after "${name} =".`);
  return j;
}

// -> { bg?, active?, cleared?, optionsKey?, popSel?, popClose?, popPos?, rows: [{ k, u, t, s? }] }; throws Error(message) if the file is not a valid ini
function parseIni(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split("\n");
  const v = {};
  let rows = null, pops = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = /^(\w+)\s*=(.*)$/.exec(t);
    if (m && Object.hasOwn(SCALARS, m[1].toLowerCase())) {
      const name = SCALARS[m[1].toLowerCase()];
      if (name in v) throw new Error(`Line ${i + 1}: "${m[1]}" is defined twice.`);
      v[name] = m[2].trim();
    } else if (/^list\s*=\s*"?$/i.test(t)) {
      if (rows) throw new Error(`Line ${i + 1}: "list" is defined twice.`);
      let j = blockStart(lines, i, "list");
      rows = [];
      let closed = false;
      for (j++; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l.startsWith(")")) { closed = true; break; }
        if (!l) continue;
        let e = /^(.+?)\t+(.+)$/.exec(l);
        if (e) rows.push(mkRow(e[1].trim(), e[2].trim()));
        else if ((e = /^([^:|]+)\|([^|]*)\|(.+)$/.exec(l))) {
          const c = e[2].split(",").map(x => x.trim()).filter(Boolean).join(" & ");
          rows.push(mkRow(c ? `${e[1].trim()} @ ${c}` : e[1].trim(), e[3].trim()));
        }
        else if ((e = /^(.+?):(.+)$/.exec(l))) rows.push(mkRow(e[1].trim(), e[2].trim()));
        else throw new Error(`Line ${j + 1}: expected "shortcut<TAB>url", found "${l}".`);
      }
      if (!closed) throw new Error('The list is not closed with ")".');
      i = j;
    } else if (/^popups\s*=\s*"?$/i.test(t)) {
      if (pops) throw new Error(`Line ${i + 1}: "popups" is defined twice.`);
      let j = blockStart(lines, i, "popups");
      pops = new Map();
      let cur = null, closed = false;
      for (j++; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l.startsWith(")")) { closed = true; break; }
        if (!l) continue;
        let e = /^\[([^\[\]\t]+)\]$/.exec(l);
        if (e) {
          const key = e[1].trim().toLowerCase();
          if (pops.has(key)) throw new Error(`Line ${j + 1}: popup "${e[1].trim()}" is defined twice.`);
          cur = [];
          pops.set(key, cur);
        }
        else if (cur && (e = /^(.+?)\t+(.+)$/.exec(l))) cur.push(mkRow(e[1].trim() === "_" ? "" : e[1].trim(), e[2].trim(), true));   // "_" = no shortcut
        else throw new Error(`Line ${j + 1}: expected "[popup name]" or "shortcut<TAB>url", found "${l}".`);
      }
      if (!closed) throw new Error('The popups block is not closed with ")".');
      i = j;
    } else {
      throw new Error(`Line ${i + 1}: unexpected content "${t}".`);
    }
  }
  if (rows === null) throw new Error('Missing "list =" block.');
  const used = new Set();
  for (const r of rows) {
    if (r.t !== "popup") continue;
    const key = r.u.toLowerCase();
    if (used.has(key)) throw new Error(`Popup "${r.u}" is used by more than one shortcut.`);
    used.add(key);
    r.s = (pops && pops.get(key)) || [];
    if (key === popupKey(r.k).toLowerCase()) r.u = "";   // written for an unnamed popup: named after its own shortcut
  }
  if (pops) for (const key of pops.keys()) if (!used.has(key)) throw new Error(`Popup "${key}" has no shortcut of type P pointing to it.`);
  return { ...v, rows };
}

// Ini name used for a popup without a name: its shortcut, minus characters not allowed in names
const popupKey = (k) => k.replace(/[\[\]\t]/g, "").trim() || "unnamed";

// Only complete rows (shortcut and URL) are written; popup sub rows only need a URL ("_" stands for no shortcut).
// A popup needs a shortcut but no name (it is then named after its shortcut) and may be empty.
function serializeIni(s, optionsKey, rows, pk) {
  const done = (r) => r.k && (r.u || r.t === "popup");
  const names = new Map();   // popup row -> name written to the ini
  const taken = new Set(rows.filter(r => r.t === "popup" && done(r) && r.u).map(r => r.u.toLowerCase()));
  for (const r of rows) {
    if (r.t !== "popup" || !done(r) || r.u) continue;
    const base = popupKey(r.k);
    let n = base, i = 2;
    while (taken.has(n.toLowerCase())) n = `${base} ${i++}`;   // clash with a named popup
    taken.add(n.toLowerCase());
    names.set(r, n);
  }
  const name = (r) => names.get(r) ?? r.u;
  const line = (r) => `${r.k || "_"}\t${r.t === "code" ? `{${r.u}}` : r.t === "popup" ? `[${name(r)}]` : r.u}`;
  const pops = rows.filter(r => r.t === "popup" && done(r))
    .map(r => ({ r, s: (r.s || []).filter(x => x.u) }));
  const body = rows.filter(done).map(line);
  return [
    `background = ${s.bg}`,
    `active_font = ${s.active}`,
    `cleared_font = ${s.cleared}`,
    `options_key = ${optionsKey}`,
    `popup_select = ${pk.sel}`,
    `popup_close = ${pk.close}`,
    `popup_position = ${pk.pos}`,
    'list = "', "(", ...body, ')"',
    'popups = "', "(", ...pops.flatMap(p => [`[${name(p.r)}]`, ...p.s.map(line)]), ')"'
  ].join("\r\n");
}
