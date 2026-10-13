// Splitting a CMake file: each top-level function() and macro() moves to its own .cmake file and is
// include()d at the same place, so evaluation order and scope stay exactly as they were.

import path from 'node:path';
import { nameFiles } from './plan.mjs';

const LOCATION = /CMAKE_CURRENT_LIST_(?:DIR|FILE|LINE)|CMAKE_PARENT_LIST_FILE|CMAKE_CURRENT_FUNCTION_LIST_(?:DIR|FILE|LINE)/i;

/** Top-level commands: [{ name, start, end, args }] where `end` is just after the closing parenthesis. */
export function commands(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let depth = 0;
  let current = null;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      const m = /^#\[(=*)\[/.exec(text.slice(i, i + 40));
      if (m) { const close = text.indexOf(`]${m[1]}]`, i); i = close < 0 ? n : close + m[1].length + 2; continue; }
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '[') {
      const m = /^\[(=*)\[/.exec(text.slice(i, i + 40));
      if (m) { const close = text.indexOf(`]${m[1]}]`, i); i = close < 0 ? n : close + m[1].length + 2; continue; }
    }
    if (c === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')') {
      depth -= 1;
      if (depth === 0 && current) { current.end = i + 1; current.args = text.slice(current.open + 1, i); out.push(current); current = null; }
      i += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(c) && (i === 0 || /[\s;]/.test(text[i - 1]) || text[i - 1] === ')')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text.slice(i, i + 200));
      if (m) { current = { name: m[1].toLowerCase(), start: i, open: i + m[0].length - 1 }; i += m[0].length - 1; continue; }
      const word = /^[A-Za-z0-9_]+/.exec(text.slice(i, i + 200));
      i += word ? word[0].length : 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Split a CMakeLists.txt or *.cmake file. `file` is repo-relative (posix). */
export function splitCmake({ file, text, minLines = 150, minGroups = 3, existing = new Set() }) {
  const lineCount = text.split('\n').length;
  if (lineCount < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const cmds = commands(text);
  const blocks = [];
  let open = null;
  let nest = 0;
  for (const c of cmds) {
    if (c.name === 'function' || c.name === 'macro') {
      if (nest === 0) open = { kind: c.name, start: c.start, name: (c.args.trim().split(/\s+/)[0] || '').replace(/^"|"$/g, '') };
      nest += 1;
    } else if (c.name === 'endfunction' || c.name === 'endmacro') {
      nest -= 1;
      if (nest === 0 && open) { blocks.push({ ...open, end: c.end }); open = null; }
      if (nest < 0) return { ok: false, reason: 'unbalanced function()/endfunction()' };
    }
  }
  if (nest !== 0) return { ok: false, reason: 'unbalanced function()/endfunction()' };
  // Comment lines directly above a block go with it.
  const lines = text.split('\n');
  const lineStart = [0];
  for (let k = 0; k < text.length; k += 1) if (text[k] === '\n') lineStart.push(k + 1);
  const lineOf = (offset) => { let lo = 0; let hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };
  const movable = [];
  let prevEnd = -1;
  for (const b of blocks) {
    let first = lineOf(b.start);
    while (first - 1 > lineOf(Math.max(prevEnd, 0)) && lines[first - 1].trim().startsWith('#') && !/^#\[=*\[/.test(lines[first - 1].trim())) first -= 1;
    prevEnd = b.end;
    const body = text.slice(lineStart[first], b.end);
    if (!b.name || LOCATION.test(body)) continue;
    movable.push({ ...b, from: lineStart[first], body, names: [b.name], primary: b.name });
  }
  if (movable.length < minGroups) return { ok: false, reason: `only ${movable.length} movable function${movable.length === 1 ? '' : 's'}` };

  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const folderName = base.toLowerCase() === 'cmakelists.txt' ? 'cmake' : base.replace(/\.cmake$/i, '');
  const folder = `${dir === '.' ? '' : `${dir}/`}${folderName}`;
  const stems = nameFiles(movable, new Set([...existing].filter((n) => n.endsWith('.cmake')).map((n) => n.replace(/\.cmake$/, ''))));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const files = [];
  const parts = [];
  movable.forEach((m, i) => {
    const content = `${m.body.replace(/\r?\n/g, eol)}${eol}`;
    const rel = `${folder}/${stems[i]}.cmake`;
    files.push({ rel, content });
    parts.push({ file: rel, names: m.names, lines: content.split(eol).length - 1 });
    m.stem = stems[i];
  });
  let root = text;
  for (const m of [...movable].sort((a, b) => b.from - a.from)) {
    root = `${root.slice(0, m.from)}include("\${CMAKE_CURRENT_LIST_DIR}/${folderName}/${m.stem}.cmake")${root.slice(m.end)}`;
  }
  // Every piece must still be balanced, and nothing was lost.
  for (const f of files) {
    const c = commands(f.content);
    const opens = c.filter((x) => x.name === 'function' || x.name === 'macro').length;
    const closes = c.filter((x) => x.name === 'endfunction' || x.name === 'endmacro').length;
    if (opens !== 1 || closes !== 1) return { ok: false, reason: `${f.rel} would not be balanced` };
  }
  const after = commands(root);
  const keptDefs = after.filter((x) => x.name === 'function' || x.name === 'macro').length;
  if (keptDefs + movable.length !== blocks.length) return { ok: false, reason: 'a definition would be lost' };
  return { ok: true, root, files, parts, folder, lines: lineCount, rootLines: root.split('\n').length };
}
