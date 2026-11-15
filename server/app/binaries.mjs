// Finding the agent CLIs (Claude Code, Codex, Gemini, Antigravity) on this computer, and the models they offer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execSync, execFileSync } from 'node:child_process';

function npmRoots() {
  const roots = [];
  if (process.env.TANDEM_NPM_ROOT) roots.push(process.env.TANDEM_NPM_ROOT);
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    /* npm not on PATH; the other candidates may still work */
  }
  return roots;
}

function firstExisting(roots, rel) {
  for (const r of roots) {
    const p = path.join(r, ...rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function nativeBinary(name) {
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), '.local', 'bin', `${name}.exe`);
    return fs.existsSync(candidate) ? candidate : null;
  }
  try { return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** Google's Antigravity CLI is a single program called `agy`. Its own installer puts it under the user's local app data on Windows. */
function antigravityBinary() {
  if (process.env.TANDEM_AGY) return fs.existsSync(process.env.TANDEM_AGY) ? process.env.TANDEM_AGY : null;
  if (process.platform === 'win32') {
    const candidates = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'), path.join(os.homedir(), '.local', 'bin', 'agy.exe')].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p)) || null;
  }
  return nativeBinary('agy');
}

/** Codex's name for this kind of computer, as its packages use it. Pure. */
export function codexTriple(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  const os_ = platform === 'win32' ? 'pc-windows-msvc' : platform === 'darwin' ? 'apple-darwin' : platform === 'linux' ? 'unknown-linux-musl' : null;
  return a && os_ ? `${a}-${os_}` : null;
}
/** Where Tandem keeps programs it installed itself (the account setup puts Codex here). */
export const toolsDir = () => process.env.TANDEM_TOOLS || path.join(os.homedir(), '.tandem', 'tools');
function tandemCodex() {
  const triple = codexTriple();
  if (!triple) return null;
  const p = path.join(toolsDir(), 'codex', 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
  return fs.existsSync(p) ? p : null;
}

/** Where each CLI lives right now. Called again after an install so a new CLI works without restarting Tandem. */
function detect() {
  const roots = npmRoots();
  const nativeClaude = nativeBinary('claude');
  const claudeExe = nativeClaude && fs.existsSync(nativeClaude) ? nativeClaude : firstExisting(roots, ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
  const codexJs = firstExisting(roots, ['@openai', 'codex', 'bin', 'codex.js']);
  const nativeCodex = tandemCodex() || nativeBinary('codex');
  const geminiJs = firstExisting(roots, ['@google', 'gemini-cli', 'bundle', 'gemini.js']);
  const nativeGemini = nativeBinary('gemini');
  const agy = antigravityBinary();
  // Electron can execute Node scripts when this child-only flag is set.
  const nodeEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return {
    claude: claudeExe ? { file: claudeExe, args: [] } : null,
    codex: codexJs ? { file: process.execPath, args: [codexJs], environment: nodeEnv } : nativeCodex ? { file: nativeCodex, args: [] } : null,
    gemini: geminiJs ? { file: process.execPath, args: [geminiJs], environment: nodeEnv } : nativeGemini ? { file: nativeGemini, args: [] } : null,
    antigravity: agy ? { file: agy, args: [] } : null,
  };
}

/** How to start each CLI, or null when it is not installed. The object is updated in place by refreshSpecs(). */
export const specs = detect();

export function refreshSpecs() {
  Object.assign(specs, detect());
  loadAntigravityModels();
  return specs;
}

/** The CLIs Tandem can install and connect, with the npm package and the command that signs in. */
export const CLIS = {
  claude: { name: 'Claude Code', pkg: '@anthropic-ai/claude-code', login: ['auth', 'login'], status: ['auth', 'status'] },
  codex: { name: 'Codex CLI', pkg: '@openai/codex', login: ['login'], status: ['login', 'status'] },
  gemini: { name: 'Gemini CLI', pkg: '@google/gemini-cli', login: [], status: null },
  // No npm package: it comes with Google's own installer. Listing its models only works when it is signed in.
  antigravity: { name: 'Antigravity CLI', pkg: '', login: [], status: ['models'] },
};

/** `agy models` prints one `id<TAB>label` per line. Pure, so it can be tested. */
export function parseAntigravityModels(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map((line) => line.split('\t')[0].trim()).filter((m) => /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(m) && !/\s/.test(m)))];
}
let antigravityModels = [];
let antigravityLabels = {};
/** Ask the Antigravity CLI for its model list in the background; the answer is used the next time a browser asks. */
function loadAntigravityModels() {
  if (!specs.antigravity || process.env.TANDEM_NO_AUTOSCAN) return;
  execFile(specs.antigravity.file, [...specs.antigravity.args, 'models'], { timeout: 20000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
    if (!err) { const list = parseAntigravityModels(String(out).split(/\r?\n/).filter((l) => l.includes('\t')).join('\n')); if (list.length) { antigravityModels = list; antigravityLabels = Object.fromEntries(String(out).split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length > 1 && list.includes(p[0].trim())).map((p) => [p[0].trim(), p[1].trim().slice(0, 60)])); } }
  });
}
loadAntigravityModels();

/** The names providers show for their models, by provider then model id. Only Antigravity lists them. */
export const modelLabels = () => ({ antigravity: antigravityLabels });

/**
 * Each provider's models with whatever it says about them: { provider: [{ id, label, about }] }, best first.
 * The Team dispatcher sizes models from this (see ../team.mjs).
 */
export function modelCatalog() {
  let codex = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = (cache.models || []).filter((m) => typeof m.slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(m.slug))
      .map((m) => ({ id: m.slug, label: String(m.display_name || m.slug).slice(0, 60), about: String(m.description || '').slice(0, 200) }));
  } catch { /* no Codex model list on this computer */ }
  return {
    claude: [{ id: 'opus', label: 'Claude Opus' }, { id: 'sonnet', label: 'Claude Sonnet' }, { id: 'haiku', label: 'Claude Haiku' }],
    codex,
    gemini: [],
    antigravity: antigravityModels.map((id) => ({ id, label: antigravityLabels[id] || id })),
  };
}

export function modelChoices() {
  let codex = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = (cache.models || []).map((m) => m.slug).filter((m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(m));
  } catch {}
  return { claude: ['opus', 'sonnet', 'haiku'], codex: [...new Set(codex)], gemini: [], antigravity: antigravityModels };
}
