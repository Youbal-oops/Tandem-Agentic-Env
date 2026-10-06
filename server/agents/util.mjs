// Small helpers for text and for the agent child processes.

import { execFile } from 'node:child_process';

export const trunc = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;
};

/** Shorten every string in a value so a huge tool input cannot bloat the chat. */
export function trimDeep(v, n = 1500) {
  if (typeof v === 'string') return trunc(v, n);
  if (Array.isArray(v)) return v.slice(0, 40).map((x) => trimDeep(x, n));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trimDeep(x, n)]));
  return v;
}

export function stringifyContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.text ?? (b?.type === 'image' ? '[image]' : JSON.stringify(b)))).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

export function killTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') {
    proc.stdin?.end();
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, (err) => { if (err && proc.exitCode === null) proc.kill(); });
  }
  else proc.kill('SIGTERM');
}

/** Stop a process quietly: its exit and errors will not be reported as a failed turn. */
export function quietKill(proc) {
  if (!proc) return;
  proc.__quiet = true;
  killTree(proc);
}

/** Environment for the agent processes: never inherit API keys (subscriptions only) or a parent session. */
export function cleanEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete env[k];
  if (env.CLAUDECODE) for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  return env;
}
