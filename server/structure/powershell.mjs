// Splitting a PowerShell script or module: each top-level function moves to its own .ps1 file that the
// original dot-sources in the same place, so definitions run in the same scope and the same order.

import path from 'node:path';
import { nameFiles } from './plan.mjs';

const LOCATION = /\$PSScriptRoot|\$PSCommandPath|\$MyInvocation|\$\{?PSScriptRoot\}?|\bGet-PSCallStack\b/i;

/**
 * Walk the text once and return the top-level `function`/`filter` definitions as
 * [{ name, start, end }] (offsets), plus whether all braces balanced.
 */
export function topLevelFunctions(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let depth = 0; // braces
  let paren = 0;
  let pending = null;
  let atLineStart = true;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '<' && next === '#') { const close = text.indexOf('#>', i + 2); i = close < 0 ? n : close + 2; atLineStart = false; continue; }
    if (c === '#') { const nl = text.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (c === '@' && (next === "'" || next === '"')) {
      const q = next;
      const re = new RegExp(`\\r?\\n${q}@`);
      const m = re.exec(text.slice(i + 2));
      i = m ? i + 2 + m.index + m[0].length : n;
      atLineStart = false;
      continue;
    }
    if (c === "'") { i += 1; while (i < n) { if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } break; } i += 1; } i += 1; atLineStart = false; continue; }
    if (c === '"') { i += 1; while (i < n) { if (text[i] === '`') { i += 2; continue; } if (text[i] === '"') { if (text[i + 1] === '"') { i += 2; continue; } break; } i += 1; } i += 1; atLineStart = false; continue; }
    if (c === '`') { i += 2; continue; }
    if (c === '\n' || c === ';') { atLineStart = true; i += 1; continue; }
    if (c === '(') { paren += 1; i += 1; continue; }
    if (c === ')') { paren -= 1; i += 1; continue; }
    if (c === '{') {
      if (pending && depth === 0 && paren === 0) { pending.bodyStart = i; }
      depth += 1; i += 1; atLineStart = false; continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0 && pending && pending.bodyStart !== undefined) { out.push({ name: pending.name, start: pending.start, end: i + 1 }); pending = null; }
      i += 1; atLineStart = false;
      continue;
    }
    if (atLineStart && depth === 0 && paren === 0 && /[Ff]/.test(c)) {
      const m = /^(function|filter)\s+((?:global:|script:|local:|private:)?[A-Za-z_][\w-]*)/i.exec(text.slice(i, i + 200));
      if (m) { pending = { name: m[2].replace(/^(global|script|local|private):/i, ''), start: i }; i += m[0].length; atLineStart = false; continue; }
    }
    if (!/\s/.test(c)) atLineStart = false;
    i += 1;
  }
  return { functions: out, balanced: depth === 0 && paren === 0 };
}

export function splitPowerShell({ file, text, minLines = 150, minGroups = 3, existing = new Set() }) {
  const lineCount = text.split('\n').length;
  if (lineCount < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const bom = text.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const src = bom ? text.slice(1) : text;
  const found = topLevelFunctions(src);
  if (!found.balanced) return { ok: false, reason: 'braces do not balance, so it cannot be read safely' };
  const lines = src.split('\n');
  const lineStart = [0];
  for (let k = 0; k < src.length; k += 1) if (src[k] === '\n') lineStart.push(k + 1);
  const lineOf = (offset) => { let lo = 0; let hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= offset) lo = mid; else hi = mid - 1; } return lo; };
  const movable = [];
  let prevEnd = 0;
  for (const f of found.functions) {
    let first = lineOf(f.start);
    // comment-based help: `#` lines or a `<# ... #>` block right above
    while (first > 0 && lineOf(prevEnd) < first - 1) {
      const above = lines[first - 1].trim();
      if (above.endsWith('#>')) {
        let j = first - 1;
        while (j >= 0 && !lines[j].includes('<#')) j -= 1;
        if (j >= 0 && j > lineOf(prevEnd)) { first = j; continue; }
        break;
      }
      if (above.startsWith('#')) { first -= 1; continue; }
      break;
    }
    prevEnd = f.end;
    const body = src.slice(lineStart[first], f.end);
    if (LOCATION.test(body)) continue;
    movable.push({ ...f, from: lineStart[first], body, names: [f.name], primary: f.name });
  }
  if (movable.length < minGroups) return { ok: false, reason: `only ${movable.length} movable function${movable.length === 1 ? '' : 's'}` };

  const dir = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const stem = base.replace(/\.(ps1|psm1)$/i, '');
  const folderName = existing.has(stem.toLowerCase()) ? `${stem}_parts` : stem;
  const folder = `${dir === '.' ? '' : `${dir}/`}${folderName}`;
  const names = nameFiles(movable, new Set([...existing].filter((n) => n.endsWith('.ps1')).map((n) => n.replace(/\.ps1$/, ''))));
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const files = [];
  const parts = [];
  movable.forEach((m, i) => {
    m.stem = names[i];
    const content = `${bom}${m.body.replace(/\r?\n/g, eol)}${eol}`;
    const rel = `${folder}/${m.stem}.ps1`;
    files.push({ rel, content });
    parts.push({ file: rel, names: m.names, lines: content.split(eol).length - 1 });
  });
  let root = src;
  for (const m of [...movable].sort((a, b) => b.from - a.from)) {
    root = `${root.slice(0, m.from)}. "$PSScriptRoot/${folderName}/${m.stem}.ps1"${root.slice(m.end)}`;
  }
  root = bom + root;
  // Check: balanced everywhere, and every function is either still here or in exactly one piece.
  const again = topLevelFunctions(src.length ? root.replace(/^﻿/, '') : root);
  if (!again.balanced) return { ok: false, reason: 'the result would not balance' };
  for (const f of files) {
    const t = topLevelFunctions(f.content.replace(/^﻿/, ''));
    if (!t.balanced || t.functions.length !== 1) return { ok: false, reason: `${f.rel} would not hold exactly one function` };
  }
  if (again.functions.length + movable.length !== found.functions.length) return { ok: false, reason: 'a function would be lost' };
  return { ok: true, root, files, parts, folder, lines: lineCount, rootLines: root.split('\n').length };
}
