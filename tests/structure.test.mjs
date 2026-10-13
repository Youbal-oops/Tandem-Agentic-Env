import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkspace } from '../server/workspace.mjs';

const fixture2 = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
import { planGroups, fileStem, nameFiles } from '../server/structure/plan.mjs';
import { splitJs } from '../server/structure/js.mjs';

const unit = (id, names, refs = [], extra = {}) => ({ id, names, refs: new Set(refs), assigns: new Set(), mustStay: false, exported: false, ...extra });

test('grouping: independent pieces separate, cycles and reassigned state stay together, private helpers fold in', () => {
  const units = [
    unit(0, ['a'], ['helper'], { exported: true }),
    unit(1, ['helper']),
    unit(2, ['b'], ['c'], { exported: true }),
    unit(3, ['c'], ['b']),
    unit(4, ['counter'], [], { exported: false }),
    unit(5, ['bump'], ['counter'], { exported: true, assigns: new Set(['counter']) }),
    unit(6, ['d'], [], { exported: true }),
  ];
  const plan = planGroups(units, { minGroups: 3 });
  const byName = (n) => plan.movable.find((g) => g.names.includes(n));
  assert.deepEqual(byName('a').names.sort(), ['a', 'helper'], 'a single-user helper folds into its user');
  assert.deepEqual(byName('b').names.sort(), ['b', 'c'], 'mutual recursion cannot be split');
  assert.deepEqual(byName('bump').names.sort(), ['bump', 'counter'], 'reassigned state stays with its declaration');
  assert.deepEqual(byName('d').names, ['d']);
  assert.equal(plan.movable.length, 4);
});

test('grouping: what must stay pulls its dependents with it, and too few pieces means no split', () => {
  const units = [
    unit(0, ['url'], [], { mustStay: true }),
    unit(1, ['useUrl'], ['url'], { exported: true }),
    unit(2, ['x'], [], { exported: true }),
    unit(3, ['y'], [], { exported: true }),
  ];
  const plan = planGroups(units, { minGroups: 2 });
  assert.deepEqual(plan.stay.sort(), [0, 1]);
  assert.equal(plan.movable.length, 2);
  assert.match(planGroups(units, { minGroups: 3 }).reason, /only 2 separable pieces/);
  assert.equal(fileStem('index'), '_index');
  assert.equal(fileStem('CON'), '_CON');
  assert.deepEqual(nameFiles([{ primary: 'A' }, { primary: 'a' }, { primary: 'B' }]), ['A', 'a_2', 'B']);
});

const MODULE = `// A small library.
import path from 'node:path';
import { sep as separator } from 'node:path';

const PREFIX = 'v';
let counter = 0;

/** Adds one. */
export function bump() {
  counter += 1;
  return counter;
}

export function read() {
  return counter;
}

function even(n) { return n === 0 ? true : odd(n - 1); }
function odd(n) { return n === 0 ? false : even(n - 1); }
export const isEven = (n) => even(n);

export class Greeter {
  greet(n) { return \`\${PREFIX}:hello \${n} \${path.basename('/a/b')}\${separator.length}\`; }
}

export function words(s) { return s.split(' ').length; }

globalThis.__structureLoaded = (globalThis.__structureLoaded || 0) + 1;

export { PREFIX as prefix };

export default function main() {
  return [bump(), bump(), read(), isEven(4), new Greeter().greet('x'), words('a b c')];
}
`;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-structure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 }));
  return dir;
}

test('a split module behaves the same and exports the same names', async (t) => {
  const dir = tmp(t);
  const out = splitJs({ file: 'lib.js', text: MODULE, minLines: 1, minGroups: 3 });
  assert.equal(out.ok, true, out.reason);
  fs.mkdirSync(path.join(dir, 'before')); fs.writeFileSync(path.join(dir, 'before', 'lib.js'), MODULE);
  fs.mkdirSync(path.join(dir, 'after', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'after', 'lib.js'), out.root);
  for (const f of out.files) fs.writeFileSync(path.join(dir, 'after', f.rel), f.content);

  // pieces: counter state together, the even/odd cycle together, the class with the prefix it uses
  const names = out.parts.map((p) => p.names.slice().sort().join('+')).sort();
  assert.ok(names.includes('bump+counter'), names.join(' | '));
  assert.ok(names.includes('read'), 'a reader of the counter is its own file and imports it');
  assert.ok(names.includes('even+isEven+odd'), names.join(' | '));
  assert.ok(out.rootLines < out.lines);
  assert.match(out.root, /Standardized by Tandem/);
  assert.match(out.root, /export \{ prefix \}|export \{ PREFIX as prefix \}/);

  const a = await import(`${pathToFileURL(path.join(dir, 'before', 'lib.js')).href}?v=1`);
  const b = await import(`${pathToFileURL(path.join(dir, 'after', 'lib.js')).href}?v=1`);
  assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort());
  assert.deepEqual(b.default(), a.default());
  assert.equal(b.prefix, a.prefix);
  assert.equal(globalThis.__structureLoaded, 2, 'the side effect still runs once per module load');
  delete globalThis.__structureLoaded;
});

test('a file that depends on its own location, CommonJS and small files are left alone', () => {
  const pathy = `import fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nconst here = fileURLToPath(new URL('.', import.meta.url));\nexport function a() { return here; }\nexport function readIt() { return fs.readFileSync(here); }\nexport function b() { return 1; }\nexport function c() { return 2; }\nexport function d() { return 3; }\n`;
  const r = splitJs({ file: 'p.js', text: pathy, minLines: 1, minGroups: 3 });
  // a and readIt stay with `here`; b, c, d are free to move
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.root.includes('import.meta.url'));
  assert.ok(r.parts.every((p) => !p.names.includes('a') && !p.names.includes('readIt')));
  assert.match(splitJs({ file: 'c.js', text: 'const x = require("y");\nmodule.exports = { x };\n'.repeat(3), minLines: 1 }).reason, /not an ES module/);
  assert.match(splitJs({ file: 's.js', text: MODULE, minLines: 1000 }).reason, /under 1000 lines/);
  assert.match(splitJs({ file: 'e.js', text: 'export function (', minLines: 1 }).reason, /syntax errors/);
});

test('React components split into one file each, keeping the React import and the default export', () => {
  const src = `import React, { useState } from 'react';
import { format } from './format.js';
import './style.css';

export function Header({ title }) {
  return <h1>{format(title)}</h1>;
}

export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}

function Footer() {
  return <footer>done</footer>;
}

export default function App() {
  return (
    <div>
      <Header title="hi" />
      <Counter />
      <Footer />
    </div>
  );
}
`;
  const r = splitJs({ file: 'src/App.jsx', text: src, minLines: 1, minGroups: 3 });
  assert.equal(r.ok, true, r.reason);
  const files = Object.fromEntries(r.files.map((f) => [path.posix.basename(f.rel), f.content]));
  assert.deepEqual(Object.keys(files).sort(), ['App.jsx', 'Counter.jsx', 'Header.jsx'], 'Footer is only used by App, so it moves with it');
  assert.match(files['App.jsx'], /function Footer\(\)/);
  assert.match(files['Counter.jsx'], /import React, \{ useState \} from 'react';/);
  assert.match(files['Header.jsx'], /import \{ format \} from '\.\.\/format\.js';/, 'relative imports are re-based to the new folder');
  assert.match(files['App.jsx'], /import \{ Header \} from '\.\/Header\.jsx';/);
  assert.match(files['App.jsx'], /export default function App/);
  assert.match(r.root, /export \{ default \} from '\.\/App\/App\.jsx';/);
  assert.match(r.root, /export \{ Header \} from '\.\/App\/Header\.jsx';/);
  assert.match(r.root, /import '\.\/style\.css';/, 'side-effect imports stay in the original file');
  assert.doesNotMatch(r.root, /useState/);
});

test('TypeScript: types are re-exported as types and the extension style of the file is followed', () => {
  const src = `import { z } from './z.js';
export interface Shape { area(): number }
export type Id = string;
export enum Kind { A, B }
export function area(s: Shape): number { return s.area(); }
export function make(id: Id): Shape { return { area: () => z(id.length) }; }
export class Box implements Shape { area() { return 1; } }
`;
  const r = splitJs({ file: 'src/shapes.ts', text: src, minLines: 1, minGroups: 3 });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.root, /export type \{ Shape \} from '\.\/shapes\/Shape\.js';/);
  assert.match(r.root, /export \{ Kind \} from '\.\/shapes\/Kind\.js';/);
  const area = r.files.find((f) => f.rel.endsWith('/area.ts'));
  assert.match(area.content, /import type \{ Shape \} from '\.\/Shape\.js';/);
});

import { execFileSync } from 'node:child_process';
import { findPython, splitPy } from '../server/structure/py.mjs';

const PY = `"""A small module."""
import os
import json as j
from collections import OrderedDict as OD

LIMIT = 3
_counter = 0


def bump():
    global _counter
    _counter += 1
    return _counter


def read():
    return _counter


# Triples a number.
def helper(x):
    return x * LIMIT


class Box:
    def __init__(self, v):
        self.v = helper(v)

    def dump(self):
        return j.dumps({'v': self.v, 'cwd_is_str': isinstance(os.getcwd(), str)})


def build():
    return OD(a=Box(2).v)


REGISTRY = {}
REGISTRY['x'] = build()

if __name__ == '__main__':
    print(bump())
`;

test('a Python module is split into a _parts package, behaves the same and keeps every name', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('Python 3 is not installed');
  const dir = tmp(t);
  const out = await splitPy({ file: 'mod.py', text: PY, minLines: 1, minGroups: 3, python: py });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.folder, 'mod_parts');
  const names = out.parts.map((p) => p.names.slice().sort().join('+'));
  assert.ok(names.includes('_counter+bump+read'), names.join(' | '));
  assert.ok(names.some((n) => n.includes('Box')), names.join(' | '));
  assert.match(out.root, /^"""A small module\."""/);
  assert.match(out.root, /from mod_parts\.Box import Box {2}# noqa: F401/);
  assert.match(out.root, /if __name__ == '__main__':/);
  fs.mkdirSync(path.join(dir, 'a')); fs.writeFileSync(path.join(dir, 'a', 'mod.py'), PY);
  fs.mkdirSync(path.join(dir, 'b', 'mod_parts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b', 'mod.py'), out.root);
  for (const f of out.files) fs.writeFileSync(path.join(dir, 'b', f.rel), f.content);
  const probe = "import sys, json; sys.path.insert(0, sys.argv[1]); import mod; "
    + "print(json.dumps({'names': sorted(n for n in dir(mod) if not n.startswith('__')), "
    + "'run': [mod.bump(), mod.bump(), mod.read(), mod.helper(2), mod.Box(1).dump(), dict(mod.REGISTRY['x'] if hasattr(mod.REGISTRY['x'], 'items') else {'x': mod.REGISTRY['x']})]}))";
  const run = (d) => JSON.parse(execFileSync(py.file, [...py.args, '-c', probe, d], { encoding: 'utf8' }));
  const before = run(path.join(dir, 'a'));
  const after = run(path.join(dir, 'b'));
  assert.deepEqual(after.run, before.run);
  assert.deepEqual(before.names.filter((n) => !after.names.includes(n)), [], 'no name is lost');
  assert.equal(execFileSync(py.file, [...py.args, path.join(dir, 'b', 'mod.py')], { encoding: 'utf8' }).trim(), '1', 'running the file directly still works');
});

test('Python: star imports, scripts that need their location and tiny files are left alone', async (t) => {
  const py = await findPython();
  if (!py) return t.skip('Python 3 is not installed');
  assert.match((await splitPy({ file: 'a.py', text: 'from os.path import *\n\ndef f(): pass\n', minLines: 1, python: py })).reason, /import \*/);
  assert.match((await splitPy({ file: 'a.py', text: 'x = 1\n', minLines: 50, python: py })).reason, /under 50 lines/);
  assert.match((await splitPy({ file: '__init__.py', text: 'x = 1\n'.repeat(300), python: py })).reason, /not split/);
  assert.match((await splitPy({ file: 'a.py', text: 'def (:\n', minLines: 1, python: py })).reason, /syntax error/);
  const location = 'import os\nHERE = os.path.dirname(__file__)\ndef a(): return HERE\ndef b(): return 1\ndef c(): return 2\ndef d(): return 3\n';
  const r = await splitPy({ file: 'loc.py', text: location, minLines: 1, minGroups: 3, python: py });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.parts.every((p) => !p.names.includes('HERE') && !p.names.includes('a')), 'what uses __file__ stays put');
});

import { splitCmake, commands } from '../server/structure/cmake.mjs';
import { splitPowerShell, topLevelFunctions } from '../server/structure/powershell.mjs';
import { reportCpp, reportEjs } from '../server/structure/report.mjs';

const CMAKE = `cmake_minimum_required(VERSION 3.20)
project(Demo)

# Adds a warning flag.
function(add_warnings target)
  target_compile_options(\${target} PRIVATE -Wall)
endfunction()

macro(log msg)
  message(STATUS "[demo] \${msg}")  # not a function ( with a paren
endmacro()

function(locate_here)
  set(HERE "\${CMAKE_CURRENT_LIST_DIR}" PARENT_SCOPE)
endfunction()

function(make_exe name)
  add_executable(\${name} \${ARGN})
  add_warnings(\${name})
endfunction()

function(make_lib name)
  add_library(\${name} \${ARGN})
  add_warnings(\${name})
endfunction()

make_exe(app main.c)
`;

test('CMake: functions and macros move to .cmake files included in the same place', () => {
  assert.deepEqual(commands('a(1)\n# b(2)\nset(X "c(3)")\n').map((c) => c.name), ['a', 'set']);
  const r = splitCmake({ file: 'CMakeLists.txt', text: CMAKE, minLines: 1, minGroups: 3 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.folder, 'cmake');
  const names = r.parts.map((p) => p.names[0]).sort();
  assert.deepEqual(names, ['add_warnings', 'log', 'make_exe', 'make_lib']);
  assert.ok(!names.includes('locate_here'), 'a function that uses its own location stays');
  assert.match(r.root, /include\("\$\{CMAKE_CURRENT_LIST_DIR\}\/cmake\/add_warnings\.cmake"\)/);
  assert.match(r.root, /function\(locate_here\)/);
  assert.match(r.root, /^make_exe\(app main\.c\)$/m);
  const addWarnings = r.files.find((f) => f.rel.endsWith('add_warnings.cmake')).content;
  assert.match(addWarnings, /^# Adds a warning flag\.\nfunction\(add_warnings target\)/);
  assert.match(splitCmake({ file: 'CMakeLists.txt', text: 'function(a)\n', minLines: 1 }).reason, /unbalanced/);
});

const PS = `<#
.SYNOPSIS
  Demo script.
#>
param([string]$Name = 'world')

# Says hello.
function Get-Greeting {
    param([string]$Who)
    "hello $Who {not a brace"
}

<#
.SYNOPSIS
  Doubles.
#>
function Get-Double($n) { $n * 2 }

function Get-Here { $PSScriptRoot }

function script:Get-Triple($n) {
    $text = @'
}
'@
    $n * 3
}

if ($true) {
    function Get-Nested { 1 }
}

Get-Greeting $Name
`;

test('PowerShell: top-level functions move to dot-sourced files, strings and here-strings do not confuse it', () => {
  const t = topLevelFunctions(PS);
  assert.equal(t.balanced, true);
  assert.deepEqual(t.functions.map((f) => f.name), ['Get-Greeting', 'Get-Double', 'Get-Here', 'Get-Triple']);
  const r = splitPowerShell({ file: 'tools/demo.ps1', text: `\ufeff${PS.replace(/\n/g, '\r\n')}`, minLines: 1, minGroups: 3 });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.parts.map((p) => p.names[0]).sort(), ['Get-Double', 'Get-Greeting', 'Get-Triple']);
  assert.match(r.root, /\. "\$PSScriptRoot\/demo\/Get-Greeting\.ps1"/);
  assert.match(r.root, /function Get-Here/);
  assert.match(r.root, /function Get-Nested/);
  assert.ok(r.root.startsWith('\ufeff'), 'the byte order mark is kept');
  assert.ok(r.files.every((f) => f.content.startsWith('\ufeff') && f.content.includes('\r\n')));
  const greeting = r.files.find((f) => f.rel.endsWith('Get-Greeting.ps1')).content;
  assert.match(greeting, /^\ufeff# Says hello\.\r\nfunction Get-Greeting/);
  const double = r.files.find((f) => f.rel.endsWith('Get-Double.ps1')).content;
  assert.match(double, /^\ufeff<#\r\n\.SYNOPSIS\r\n  Doubles\.\r\n#>\r\nfunction Get-Double/);
});

test('C, C++ and EJS are reported, never rewritten', () => {
  const c = `#include <stdio.h>\n\n/* helpers */\nstatic int add(int a, int b) {\n  return a + b;\n}\n\nint main(int argc, char **argv) {\n  if (argc > 1) { return add(1, 2); }\n  return 0;\n}\n\nvoid Widget::draw() const {\n}\n`;
  const r = reportCpp({ file: 'main.c', text: c, minLines: 1 });
  assert.equal(r.report, true);
  assert.deepEqual(r.names, ['add', 'main', 'Widget::draw']);
  assert.match(r.note, /not split automatically/);
  assert.equal(reportCpp({ file: 'x.c', text: 'int a;\n', minLines: 50 }).ok, false);
  const e = reportEjs({ file: 'page.ejs', text: `<%- include('header') %>\n<div>x</div>\n<%- include("footer") %>\n`, minLines: 1 });
  assert.deepEqual(e.names, ['header', 'footer']);
});

import { createStructure, languageOf } from '../server/structure/index.mjs';
import { cleanStructure } from '../server/settings.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();

function project(t) {
  const dir = tmp(t);
  const repo = path.join(dir, 'proj');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(path.join(repo, 'tool'));
  fs.writeFileSync(path.join(repo, 'src', 'big.js'), MODULE);
  fs.writeFileSync(path.join(repo, 'tool', 'build.py'), PY);
  fs.writeFileSync(path.join(repo, 'CMakeLists.txt'), CMAKE);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  git(repo.replace(/proj$/, ''), 'init', '-q', 'proj');
  git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return { dir, repo };
}

test('the standardized tree is its own worktree and branch, and the original is untouched', async (t) => {
  const { dir, repo } = project(t);
  const settings = () => ({ enabled: true, minLines: 5, minGroups: 3 });
  const s = createStructure({ root: path.join(dir, 'data'), settings, originOf: () => 'cloned' });
  const plan = await s.plan(repo);
  const by = Object.fromEntries(plan.entries.map((e) => [e.file, e]));
  assert.equal(by['src/big.js'].status, 'split');
  assert.equal(by['CMakeLists.txt'].status, 'split');
  assert.ok(plan.totals.parts >= 6);
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  const out = await s.create(repo);
  assert.equal(out.created, true);
  assert.equal(out.branch, 'tandem/structure');
  assert.ok(fs.existsSync(path.join(out.path, 'src', 'big', 'bump.js')) || fs.readdirSync(path.join(out.path, 'src', 'big')).length >= 3);
  assert.match(fs.readFileSync(path.join(out.path, 'src', 'big.js'), 'utf8'), /Standardized by Tandem/);
  assert.equal(git(out.path, 'log', '-1', '--format=%s'), 'Standardize structure (Tandem)');
  assert.equal(git(out.path, 'status', '--porcelain'), '');
  // the original repository: same files, same branch tip, nothing new in its working tree
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'big.js'), 'utf8'), MODULE);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.match(out.prompt, /smaller ones on branch tandem\/structure/);
  assert.doesNotMatch(out.prompt, /globalThis/, 'the review prompt carries names, not code');
  // a second run makes a second branch rather than reusing the first
  assert.equal((await s.create(repo)).branch, 'tandem/structure-2');
});

test('only projects that came in through Tandem are restructured, and only when the option is on', async (t) => {
  const { dir, repo } = project(t);
  const on = () => ({ enabled: true, minLines: 5, minGroups: 3 });
  const opened = createStructure({ root: dir, settings: on, originOf: () => undefined });
  assert.equal(opened.status(repo).eligible, false);
  await assert.rejects(opened.plan(repo), /will not restructure it/);
  await assert.rejects(opened.create(repo), /not eligible/);
  const off = createStructure({ root: dir, settings: () => ({ enabled: false, minLines: 5, minGroups: 3 }), originOf: () => 'cloned' });
  await assert.rejects(off.plan(repo), /Turn on/);
  for (const origin of ['cloned', 'created', 'forked']) assert.equal(createStructure({ root: dir, settings: on, originOf: () => origin }).status(repo).eligible, true);
  assert.deepEqual(cleanStructure({ enabled: 'yes', minLines: 5, minGroups: 99 }), { enabled: false, minLines: 150, minGroups: 3 });
  assert.equal(languageOf('a/b.TSX'), 'js');
  assert.equal(languageOf('x.min.js'), null);
  assert.equal(languageOf('types.d.ts'), null);
  assert.equal(languageOf('src/CMakeLists.txt'), 'cmake');
  assert.equal(languageOf('a.cpp'), 'cpp');
  assert.equal(languageOf('notes.md'), null);
});

test('through the workspace: clone marks a project eligible, an opened folder is protected, fork is explicit', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ws-structure-'));
  const repo = path.join(root, 'r'); fs.mkdirSync(repo);
  const specs2 = Object.fromEntries(['claude', 'codex'].map((p) => [p, { file: process.execPath, args: [fixture2, p] }]));
  const w = createWorkspace({ root, cwd: repo, specs: specs2, pluginRoots: [path.join(root, 'plugin')], childPollMs: 60000, broadcast() {} });
  t.after(async () => { w.closeAll(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }); });
  assert.deepEqual([w.structureStatus().origin, w.structureStatus().eligible, w.structureStatus().enabled], ['opened', false, false]);
  w.saveSettings({ structure: { enabled: true, minLines: 80 } });
  assert.equal(w.settings().structure.minLines, 80);
  await assert.rejects(w.structurePlan(), /will not restructure/);
  w.markOrigin(repo, 'cloned');
  assert.equal(w.structureStatus().eligible, true);
  // the conventions reach agents only for an eligible project with the option on
  assert.match(w.localState().structure.origin, /cloned/);
});

test('grouping: tiny private helpers that only lean on each other share one file', () => {
  const units = [
    unit(0, ['$'], [], { lines: 1 }),
    unit(1, ['say'], ['$'], { lines: 2 }),
    unit(2, ['big1'], ['$', 'say'], { exported: true, lines: 40 }),
    unit(3, ['big2'], ['$'], { exported: true, lines: 40 }),
    unit(4, ['big3'], ['say'], { exported: true, lines: 40 }),
    unit(5, ['tinyUsesBig'], ['big2'], { lines: 2 }),
    unit(6, ['big4'], ['tinyUsesBig'], { exported: true, lines: 40 }),
  ];
  const plan = planGroups(units, { minGroups: 3 });
  const helpers = plan.movable.find((g) => g.primary === 'helpers');
  assert.deepEqual(helpers.names.sort(), ['$', 'say']);
  assert.ok(plan.movable.some((g) => g.names.includes('tinyUsesBig') && g.names.includes('big4')), 'a tiny helper that leans on a big piece folds into its only user');
});
