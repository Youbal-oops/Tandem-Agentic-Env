// Standardizing a project's file structure into its own tree.
//
// Only projects that came in through Tandem (cloned or created here) are eligible: a folder you opened
// yourself is left alone, because its files are the ones you push to main. Nothing is ever changed in place.
// The result is a separate git worktree on its own branch, committed, so it can be diffed, reviewed in the
// Review window, tested and merged (or thrown away) by you.
//
// The work is plain code: no model is asked to move a function. A model is only involved if you choose to
// send it the short summary this produces, to review names and grouping.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { splitJs, JS_EXT } from './js.mjs';
import { findPython, splitPy } from './py.mjs';
import { splitCmake } from './cmake.mjs';
import { splitPowerShell } from './powershell.mjs';
import { reportCpp, reportEjs } from './report.mjs';

export const STRUCTURE_DEFAULTS = Object.freeze({ enabled: false, minLines: 150, minGroups: 3 });
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'third_party', 'thirdparty', '.git', '.tandem', '__pycache__', 'venv', '.venv', 'env', 'coverage', 'target', '.next', '.cache']);
const MAX_FILES = 6000;
const MAX_BYTES = 1024 * 1024;
const CPP_EXT = new Set(['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh']);

export function languageOf(file) {
  const base = path.posix.basename(file);
  const ext = path.posix.extname(base).toLowerCase();
  if (/\.(min|bundle)\.js$|\.d\.ts$|\.generated\./i.test(base)) return null;
  if (JS_EXT.has(ext)) return 'js';
  if (ext === '.py' || ext === '.pyw') return 'py';
  if (base.toLowerCase() === 'cmakelists.txt' || ext === '.cmake') return 'cmake';
  if (ext === '.ps1' || ext === '.psm1') return 'ps';
  if (CPP_EXT.has(ext)) return 'cpp';
  if (ext === '.ejs') return 'ejs';
  return null;
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (err, out, errText) => {
      if (err) reject(new Error(String(errText).trim().split('\n').pop() || err.message));
      else resolve(String(out));
    });
  });
}

async function listFiles(repo) {
  const out = await git(repo, ['ls-files', '-z', '-c', '-o', '--exclude-standard']);
  return out.split('\0').filter(Boolean).filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)));
}

/**
 * Read every file Tandem knows how to handle and say what it would do. Returns
 * { entries: [{ file, lang, status, lines, rootLines, parts, reason, ... }], totals }.
 */
export async function planRepo(repo, { minLines, minGroups } = STRUCTURE_DEFAULTS) {
  const all = await listFiles(repo);
  const present = new Map(); // dir -> lowercase names
  for (const f of all) {
    const d = path.posix.dirname(f);
    if (!present.has(d)) present.set(d, new Set());
    present.get(d).add(path.posix.basename(f).toLowerCase());
    // directories that exist because of their files
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i - 1).join('/') || '.';
      if (!present.has(parent)) present.set(parent, new Set());
      present.get(parent).add(parts[i - 1].toLowerCase());
    }
  }
  const candidates = all.filter((f) => languageOf(f)).slice(0, MAX_FILES);
  const entries = [];
  const python = await findPython();
  for (const file of candidates) {
    const lang = languageOf(file);
    let text;
    try {
      const abs = path.join(repo, file);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (text.includes('Standardized by Tandem')) continue;
    const dir = path.posix.dirname(file);
    const existing = present.get(dir) || new Set();
    const opts = { file, text, minLines, minGroups, existing };
    let r;
    try {
      if (lang === 'js') r = splitJs(opts);
      else if (lang === 'py') r = await splitPy({ ...opts, python, isPackage: existing.has('__init__.py') });
      else if (lang === 'cmake') r = splitCmake(opts);
      else if (lang === 'ps') r = splitPowerShell(opts);
      else if (lang === 'cpp') r = reportCpp(opts);
      else r = reportEjs(opts);
    } catch (e) { r = { ok: false, reason: `could not be read: ${String(e.message).slice(0, 80)}` }; }
    if (!r.ok && /^under \d+ lines$/.test(r.reason || '')) continue; // small files are not worth listing
    entries.push({ file, lang, status: r.ok ? (r.report ? 'report' : 'split') : 'skipped', lines: r.lines ?? text.split('\n').length, rootLines: r.rootLines,
      parts: r.parts, folder: r.folder, reason: r.reason, note: r.note, names: r.names, approxFunctions: r.approxFunctions, result: r.ok && !r.report ? r : undefined });
  }
  const split = entries.filter((e) => e.status === 'split');
  return {
    entries,
    totals: {
      scanned: candidates.length,
      split: split.length,
      parts: split.reduce((n, e) => n + e.parts.length, 0),
      reported: entries.filter((e) => e.status === 'report').length,
      skipped: entries.filter((e) => e.status === 'skipped').length,
      linesBefore: split.reduce((n, e) => n + e.lines, 0),
      largestAfter: split.reduce((m, e) => Math.max(m, e.rootLines, ...e.parts.map((p) => p.lines)), 0),
    },
  };
}

/** What goes to the browser: the plan without file contents. */
export function publicPlan(plan) {
  return {
    totals: plan.totals,
    entries: plan.entries.slice(0, 300).map(({ result, ...e }) => ({ ...e, parts: e.parts?.map((p) => ({ file: p.file, names: p.names.slice(0, 6), lines: p.lines })) })),
    truncated: plan.entries.length > 300,
  };
}

/** A short, content-free summary an agent can review for naming and grouping. */
export function reviewPrompt(plan, { branch } = {}) {
  const split = plan.entries.filter((e) => e.status === 'split').slice(0, 40);
  const lines = split.map((e) => `- ${e.file} (${e.lines} lines) -> ${e.parts.map((p) => `${path.posix.basename(p.file)}[${p.names.slice(0, 3).join(', ')}]`).join(', ')}`);
  return [
    `Tandem split ${plan.totals.split} large file${plan.totals.split === 1 ? '' : 's'} into ${plan.totals.parts} smaller ones${branch ? ` on branch ${branch}` : ''}. Each original path still exists and re-exports its pieces, so imports are unchanged.`,
    'Please review the structure only: are the file names clear, is anything grouped oddly, and is there a piece that should be merged or renamed? Do not rewrite code. Reply with a short list of suggested renames or merges.',
    '', ...lines,
  ].join('\n');
}

/** Extra standing instructions for agents working in an eligible project when the option is on. */
export function conventionsPrompt({ minLines }) {
  return `[File structure conventions for this project, set in Tandem]\nKeep files small and single-purpose: one component, class or group of closely related functions per file, named after its main export, and aim to stay under about ${minLines} lines. Put new code in its own file instead of appending to a large one. Do not reorganize existing files unless asked: Tandem restructures separately.`;
}

/**
 * `ctx` supplies: root (Tandem's data root), settings() -> structure settings, origins (Map-like with get/set).
 * Creating a tree needs a git repository with at least one commit.
 */
export function createStructure({ root, settings, originOf }) {
  return {
    status(repo) {
      const origin = originOf(repo);
      const s = settings();
      return { enabled: s.enabled, origin: origin || 'opened', eligible: origin === 'cloned' || origin === 'created' || origin === 'forked',
        settings: { minLines: s.minLines, minGroups: s.minGroups } };
    },

    async plan(repo) {
      const st = this.status(repo);
      if (!st.enabled) throw new Error('Turn on "Standardize structure" in Settings first.');
      if (!st.eligible) throw new Error('This project was opened from a folder on this computer, so Tandem will not restructure it: those are the files you push to main. Clone or fork it through Tandem, or mark it as a fork.');
      return planRepo(repo, st.settings);
    },

    /** Write the standardized tree into its own worktree and branch, and commit it there. */
    async create(repo) {
      const st = this.status(repo);
      if (!st.enabled) throw new Error('Turn on "Standardize structure" in Settings first.');
      if (!st.eligible) throw new Error('This project is not eligible: it was opened from an existing folder.');
      const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
      try { await git(top, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Error('Commit something first: the structured tree is built from the last commit.'); }
      const name = path.basename(top);
      let branch = 'tandem/structure';
      for (let n = 2; ; n += 1) {
        const exists = await git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
        const dir = path.join(root, '.tandem', 'worktrees', name, branch.split('/').pop());
        if (!exists && !fs.existsSync(dir)) break;
        branch = `tandem/structure-${n}`;
        if (n > 50) throw new Error('Too many structure branches. Remove old ones with git worktree remove.');
      }
      const target = path.join(root, '.tandem', 'worktrees', name, branch.split('/').pop());
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await git(top, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      try {
        const plan = await planRepo(target, st.settings);
        const done = plan.entries.filter((e) => e.status === 'split' && e.result);
        if (!done.length) {
          await git(top, ['worktree', 'remove', '--force', target]).catch(() => {});
          await git(top, ['branch', '-D', branch]).catch(() => {});
          return { created: false, plan: publicPlan(plan), reason: 'Nothing here is big or separable enough to split.' };
        }
        for (const e of done) {
          fs.writeFileSync(path.join(target, e.file), e.result.root);
          for (const f of e.result.files) {
            fs.mkdirSync(path.dirname(path.join(target, f.rel)), { recursive: true });
            fs.writeFileSync(path.join(target, f.rel), f.content);
          }
        }
        await git(target, ['add', '-A']);
        const who = (await git(target, ['config', 'user.name']).catch(() => '')).trim();
        const identity = who ? [] : ['-c', 'user.name=Tandem', '-c', 'user.email=tandem@localhost'];
        await git(target, [...identity, 'commit', '-q', '-m', `Standardize structure (Tandem)\n\nSplit ${done.length} file${done.length === 1 ? '' : 's'} into ${plan.totals.parts} smaller files. Original paths re-export their pieces.`]);
        const commit = (await git(target, ['rev-parse', '--short', 'HEAD'])).trim();
        return { created: true, branch, path: target, commit, plan: publicPlan(plan), prompt: reviewPrompt(plan, { branch }) };
      } catch (e) {
        await git(top, ['worktree', 'remove', '--force', target]).catch(() => {});
        await git(top, ['branch', '-D', branch]).catch(() => {});
        throw e;
      }
    },
  };
}
