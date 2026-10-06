// Codex writes token counts and account limits into its own session files. Only the
// `token_count` lines are read, never the conversation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function recentDayDirs() {
  const base = path.join(CODEX_HOME, 'sessions');
  const dirs = new Set();
  const now = Date.now();
  for (let d = 0; d < 3; d++) {
    const t = new Date(now - d * 864e5);
    for (const [Y, M, D] of [[t.getFullYear(), t.getMonth() + 1, t.getDate()], [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]]) {
      dirs.add(path.join(base, String(Y), String(M).padStart(2, '0'), String(D).padStart(2, '0')));
    }
  }
  return [...dirs];
}

export function findRollout(sessionId) {
  for (const dir of recentDayDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(`-${sessionId}.jsonl`)) return path.join(dir, f);
    } catch {
      /* day folder does not exist */
    }
  }
  return null;
}

export function newestRollout() {
  let best = null;
  for (const dir of recentDayDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        const p = path.join(dir, f);
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    } catch {
      /* day folder does not exist */
    }
  }
  return best?.p || null;
}

export function lastTokenCount(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 262144);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('token_count')) continue;
        try {
          const p = JSON.parse(lines[i]).payload;
          if (p?.type === 'token_count') return p;
        } catch {
          /* partial line at the start of the window */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* file vanished */
  }
  return null;
}
