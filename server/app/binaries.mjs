// Finding the Claude Code and Codex CLIs on this computer, and the models they offer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';

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

/** Where each CLI lives right now. Called again after an install so a new CLI works without restarting Tandem. */
function detect() {
  const roots = npmRoots();
  const nativeClaude = nativeBinary('claude');
  const claudeExe = nativeClaude && fs.existsSync(nativeClaude) ? nativeClaude : firstExisting(roots, ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']);
  const codexJs = firstExisting(roots, ['@openai', 'codex', 'bin', 'codex.js']);
  const nativeCodex = nativeBinary('codex');
  const geminiJs = firstExisting(roots, ['@google', 'gemini-cli', 'bundle', 'gemini.js']);
  const nativeGemini = nativeBinary('gemini');
  // Electron can execute Node scripts when this child-only flag is set.
  const nodeEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return {
    claude: claudeExe ? { file: claudeExe, args: [] } : null,
    codex: codexJs ? { file: process.execPath, args: [codexJs], environment: nodeEnv } : nativeCodex ? { file: nativeCodex, args: [] } : null,
    gemini: geminiJs ? { file: process.execPath, args: [geminiJs], environment: nodeEnv } : nativeGemini ? { file: nativeGemini, args: [] } : null,
  };
}

/** How to start each CLI, or null when it is not installed. The object is updated in place by refreshSpecs(). */
export const specs = detect();

export function refreshSpecs() {
  Object.assign(specs, detect());
  return specs;
}

/** The CLIs Tandem can install and connect, with the npm package and the command that signs in. */
export const CLIS = {
  claude: { name: 'Claude Code', pkg: '@anthropic-ai/claude-code', login: ['auth', 'login'], status: ['auth', 'status'] },
  codex: { name: 'Codex CLI', pkg: '@openai/codex', login: ['login'], status: ['login', 'status'] },
  gemini: { name: 'Gemini CLI', pkg: '@google/gemini-cli', login: [], status: null },
};

export function modelChoices() {
  let codex = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'));
    codex = (cache.models || []).map((m) => m.slug).filter((m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(m));
  } catch {}
  return { claude: ['opus', 'sonnet', 'haiku'], codex: [...new Set(codex)], gemini: [] };
}
