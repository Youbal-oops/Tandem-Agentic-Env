// Splitting a Python module into one file per piece, in a `<name>_parts` package next to it.
//
// The module keeps its path and its names: it imports every piece back, so `from module import anything`
// still works. Python's own `ast` module does the reading (py_units.py), nothing is guessed from text.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nameFiles, planGroups } from './plan.mjs';

const HELPER = fileURLToPath(new URL('./py_units.py', import.meta.url));
// Python cannot read inside Electron's app.asar, so the helper travels as the program text (-c), not as a path.
let helperSource;
let interpreter;

/** The Python 3 to use, as { file, args } (`py -3` on Windows), or null. Looked up once. */
export function findPython(candidates = process.platform === 'win32' ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']]) {
  interpreter ||= (async () => {
    for (const [file, ...pre] of candidates) {
      const ok = await new Promise((resolve) => execFile(file, [...pre, '-c', 'import sys;print(sys.version_info[0])'], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && String(out).trim() === '3')));
      if (ok) return { file, args: pre };
    }
    return null;
  })();
  return interpreter;
}

function runHelper(py, payload) {
  return new Promise((resolve, reject) => {
    helperSource ||= fs.readFileSync(HELPER, 'utf8');
    const child = execFile(py.file, [...py.args, '-I', '-c', helperSource], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => {
      if (err) return reject(new Error('Python could not read this file.'));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('Python gave an unreadable answer.')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

const SKIP_NAMES = new Set(['__init__.py', '__main__.py', 'setup.py', 'conftest.py', 'manage.py']);

/** Returns { ok: false, reason } or { ok: true, root, files, parts, folder, lines, rootLines }. */
export async function splitPy({ file, text, isPackage = false, minLines = 150, minGroups = 3, existing = new Set(), python }) {
  const lineCount = text.split('\n').length;
  if (lineCount < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const name = path.posix.basename(file);
  if (SKIP_NAMES.has(name)) return { ok: false, reason: `${name} is not split` };
  const py = python === undefined ? await findPython() : python;
  if (!py) return { ok: false, reason: 'Python 3 was not found' };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const source = text.replace(/\r\n/g, '\n');
  const read = await runHelper(py, { mode: 'units', source });
  if (read.error) return { ok: false, reason: read.error };
  if (read.star) return { ok: false, reason: 'uses "from x import *", so names cannot be tracked' };
  const items = read.units;
  const lines = source.split('\n');
  const dir = path.posix.dirname(file);
  const stem = name.replace(/\.pyw?$/, '');
  const folderName = `${stem}_parts`;
  if (existing.has(folderName.toLowerCase())) return { ok: false, reason: `${folderName} already exists` };

  const importItems = items.filter((i) => i.kind === 'import' || i.kind === 'from');
  if (!isPackage && importItems.some((i) => i.kind === 'from' && i.level > 0)) return { ok: false, reason: 'uses relative imports outside a package' };
  const future = items.filter((i) => i.future);
  const originalBound = new Set(read.bound);

  // ---- comment blocks directly above a piece belong to it
  const startOf = (item, prevEnd) => {
    let s = item.start;
    while (s - 2 >= prevEnd && lines[s - 2].trim().startsWith('#')) s -= 1;
    return s;
  };
  const units = [];
  let prevEnd = 0;
  for (const item of items) {
    const begin = startOf(item, prevEnd);
    prevEnd = item.end;
    if (item.kind === 'import' || item.kind === 'from' || item.docstring) continue;
    const own = new Set(item.declares);
    const movable = (item.kind === 'def' || (item.kind === 'assign' && item.pure)) && !item.pathy && item.declares.length > 0;
    units.push({ id: units.length, item, begin, lines: item.end - begin + 1, names: item.declares, refs: new Set(item.refs.filter((r) => !own.has(r))), assigns: new Set(item.assigns),
      mustStay: !movable, exported: item.declares.some((n) => !n.startsWith('_')) });
  }
  // Python imports copy a binding rather than sharing it: once a module-level name is reassigned (via `global`),
  // every reader must live in the same file as the name, or it would keep seeing the value it imported.
  const mutated = new Set(units.flatMap((u) => [...u.assigns]));
  for (const u of units) for (const r of u.refs) if (mutated.has(r)) u.assigns.add(r);
  const plan = planGroups(units, { minGroups });
  if (!plan.movable.length) return { ok: false, reason: plan.reason || 'nothing can move' };

  const stems = nameFiles(plan.movable);
  const owner = new Map();
  plan.movable.forEach((g, i) => { g.stem = stems[i]; for (const n of g.names) owner.set(n, g); });

  // ---- imports a piece needs, rebuilt with only the names it uses
  const bound = new Map(); // local name -> import item
  for (const i of importItems) for (const n of i.declares) if (!bound.has(n)) bound.set(n, []);
  for (const i of importItems) for (const n of i.declares) bound.get(n).push(i);
  const importLines = (used) => {
    const out = [];
    for (const i of importItems) {
      if (i.future) continue;
      if (i.kind === 'import') {
        const keep = i.imports.filter((a) => used.has(a.asname || a.name.split('.')[0]));
        if (keep.length) out.push(`import ${keep.map((a) => (a.asname ? `${a.name} as ${a.asname}` : a.name)).join(', ')}`);
      } else {
        const keep = i.imports.filter((a) => used.has(a.asname || a.name));
        if (keep.length) out.push(`from ${'.'.repeat(i.level + (i.level > 0 ? 1 : 0))}${i.module || ''} import ${keep.map((a) => (a.asname ? `${a.name} as ${a.asname}` : a.name)).join(', ')}`);
      }
    }
    return out;
  };
  const futureLines = future.map((f) => `from __future__ import ${f.imports.map((a) => a.name).join(', ')}`);

  const files = [];
  const parts = [];
  for (const g of plan.movable) {
    const mine = new Set(g.names);
    const used = new Set(g.units.flatMap((u) => [...u.refs]));
    const sib = new Map();
    for (const r of used) {
      const o = owner.get(r);
      if (o && o !== g && !mine.has(r)) { if (!sib.has(o)) sib.set(o, []); sib.get(o).push(r); }
    }
    const header = [
      ...futureLines,
      ...importLines(used),
      ...[...sib].map(([o, names]) => `from .${o.stem} import ${names.sort().join(', ')}`),
    ];
    const body = g.units.map((u) => lines.slice(u.begin - 1, u.item.end).join('\n'));
    const content = `${header.length ? `${header.join('\n')}\n\n\n` : ''}${body.join('\n\n\n')}\n`.replace(/\n/g, eol);
    const rel = `${dir === '.' ? '' : `${dir}/`}${folderName}/${g.stem}.py`;
    files.push({ rel, content });
    parts.push({ file: rel, names: g.names, lines: content.split('\n').length - 1 });
  }
  files.push({ rel: `${dir === '.' ? '' : `${dir}/`}${folderName}/__init__.py`, content: `"""Pieces of ${name}, split out by Tandem. ${name} still provides every name."""${eol}` });

  // ---- the module itself: pieces removed, everything imported back
  const drop = new Set();
  for (const g of plan.movable) for (const u of g.units) for (let l = u.begin; l <= u.item.end; l += 1) drop.add(l);
  const kept = [];
  let lastImportAt = -1;
  const importLinesNo = new Set();
  for (const i of importItems) for (let l = i.start; l <= i.end; l += 1) importLinesNo.add(l);
  const docEnd = items.find((i) => i.docstring)?.end || 0;
  lines.forEach((line, k) => {
    const n = k + 1;
    if (drop.has(n)) return;
    kept.push({ n, line });
  });
  for (let k = 0; k < kept.length; k += 1) if (importLinesNo.has(kept[k].n)) lastImportAt = k;
  if (lastImportAt < 0 && docEnd) lastImportAt = kept.findIndex((e) => e.n === docEnd);
  const prefix = isPackage ? `.${folderName}` : folderName;
  const bring = [`# Standardized by Tandem: the pieces of this module are in ${folderName}/. Every name it defined is still available from here.`];
  for (const g of plan.movable) bring.push(`from ${prefix}.${g.stem} import ${g.names.slice().sort().join(', ')}  # noqa: F401`);
  const out = kept.map((e) => e.line);
  out.splice(lastImportAt + 1, 0, '', ...bring);
  const root = `${out.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\s+$/, '')}\n`.replace(/\n/g, eol);

  // ---- check: it parses, binds the same names, and no piece lost something it uses
  const check = await runHelper(py, { mode: 'check', files: [{ path: file, source: root }, ...files.map((f) => ({ path: f.rel, source: f.content })) ] });
  const byPath = new Map(check.files.map((f) => [f.path, f]));
  for (const f of check.files) if (f.error) return { ok: false, reason: `${f.path}: ${f.error}` };
  const newRoot = byPath.get(file);
  for (const n of originalBound) if (!newRoot.bound.includes(n)) return { ok: false, reason: `the module would lose "${n}"` };
  for (const f of files) {
    const info = byPath.get(f.rel);
    for (const u of info.uses) if (originalBound.has(u) && !info.bound.includes(u)) return { ok: false, reason: `${f.rel} would be missing "${u}"` };
  }
  return { ok: true, root, files, parts, folder: `${dir === '.' ? '' : `${dir}/`}${folderName}`, lines: lineCount, rootLines: root.split('\n').length };
}
