// Parsing/serializing "Firefox AHK Receiver.ini":
//   background = #000
//   active_font = #E0E0E0
//   cleared_font = #555
//   options_key = <ahk hotkey>
//   list = "
//   (
//   <ahk hotkey>:<url>
//   )"
// Mirrors how Firefox AHK Receiver.ahk reads it, but strict, so odd files are reported, not rewritten.
// Only "list" is required; missing optional keys fall back to defaults.

const SCALARS = { background: "bg", active_font: "active", cleared_font: "cleared", options_key: "optionsKey" };

// -> { bg?, active?, cleared?, optionsKey?, rows: [{ k, u }] }; throws Error(message) if the file is not a valid ini
function parseIni(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split("\n");
  const v = {};
  let rows = null;
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
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j >= lines.length || lines[j].trim() !== "(") throw new Error(`Line ${i + 1}: expected "(" on the line after "list =".`);
      rows = [];
      let closed = false;
      for (j++; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l.startsWith(")")) { closed = true; break; }
        if (!l) continue;
        const e = /^(.+?):(.+)$/.exec(l);
        if (!e) throw new Error(`Line ${j + 1}: expected "shortcut:url", found "${l}".`);
        rows.push({ k: e[1].trim(), u: e[2].trim() });
      }
      if (!closed) throw new Error('The list is not closed with ")".');
      i = j;
    } else {
      throw new Error(`Line ${i + 1}: unexpected content "${t}".`);
    }
  }
  if (rows === null) throw new Error('Missing "list =" block.');
  return { ...v, rows };
}

// Only complete rows (shortcut and URL) are written.
function serializeIni(s, optionsKey, rows) {
  const body = rows.filter(r => r.k && r.u).map(r => `${r.k}:${r.u}`);
  return [
    `background = ${s.bg}`,
    `active_font = ${s.active}`,
    `cleared_font = ${s.cleared}`,
    `options_key = ${optionsKey}`,
    'list = "', "(", ...body, ')"'
  ].join("\r\n");
}
