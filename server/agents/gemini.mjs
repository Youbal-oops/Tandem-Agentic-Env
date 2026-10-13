// Gemini CLI, one process per turn:  gemini -p ... -o stream-json [--resume latest]
// The task goes in on stdin (the -p text is only a pointer to it). Events come back as JSON lines:
//   init {session_id, model}  message {role, content, delta}  tool_use {tool_name, tool_id, parameters}
//   tool_result {tool_id, status, output, error}  error {severity, message}  result {status, error, stats}
// Event names and fields were read from the CLI's own source (v0.63); stats fields are read defensively.

import { spawn } from 'node:child_process';
import { GEMINI_APPROVAL, MAX_OUT } from './constants.mjs';
import { GEMINI_TOOL } from './tools.mjs';
import { cleanEnv, trimDeep, trunc } from './util.mjs';

const STUB = 'Carry out the task given on standard input.';
const AUTH = /(auth|api key|credential|login|sign in|oauth|permission_denied|unauthenticated)/i;

export function createGemini(ctx) {
  const { cwd, specs, environment, summarize, put, delta, note, fail, pushMeta, endTurnCleanup } = ctx;

  /** Close the assistant message being streamed, if any. */
  function closeMessage(a) {
    if (a.gemMsg) put(a, { k: 'msg', id: a.gemMsg, done: true });
    a.gemMsg = null;
  }

  function send(a, text, images = []) {
    const args = [...specs.gemini.args, '-p', STUB, '-o', 'stream-json', '--approval-mode', GEMINI_APPROVAL[a.mode] || 'plan', '--skip-trust'];
    if (a.modelPref) args.push('-m', a.modelPref);
    // Each agent has its own folder, and Gemini keeps sessions per folder, so "latest" is this agent's last chat.
    if (a.sessionId) args.push('--resume', 'latest');
    const refs = images.length ? `\n\nAttached images: ${images.map((i) => `@${i.path}`).join(' ')}` : '';
    const proc = spawn(specs.gemini.file, args, { cwd, env: { ...cleanEnv(), ...environment, ...specs.gemini.environment }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.stderr = '';
    a.gemMsg = null;
    let buf = '';
    let sawResult = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (proc.__quiet || a.proc !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line && onLine(a, line)) sawResult = true;
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (a.stderr = (a.stderr + d).slice(-2000)));
    proc.on('error', (e) => {
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start Gemini CLI: ${e.message}`);
      a.proc = null;
      a.busy = false;
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      if (a.proc === proc) a.proc = null;
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        closeMessage(a);
        endTurnCleanup(a, 'Gemini exited');
        if (!sawResult) {
          const hint = a.stderr.trim().split('\n').slice(-6).join('\n');
          const auth = AUTH.test(hint) ? ' It may not be signed in: open Connect agents and press Sign in for Gemini CLI.' : '';
          fail(a, `Gemini stopped${code ? ` (exit ${code})` : ''} before finishing.${auth}${hint ? '\n' + trunc(hint, 700) : ''}`);
        }
      }
      pushMeta(a);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(text + refs);
  }

  /** Returns true when the line ended the turn. */
  function onLine(a, line) {
    let m;
    try { m = JSON.parse(line); } catch { return false; }
    switch (m.type) {
      case 'init':
        a.sessionId = m.session_id || a.sessionId;
        a.model = m.model || a.model;
        pushMeta(a);
        return false;
      case 'message': {
        if (m.role !== 'assistant' || typeof m.content !== 'string') return false;
        if (!a.gemMsg) {
          a.gemMsg = `${a.id}:${a.turnNo}:m${++a.seq}`;
          put(a, { k: 'msg', id: a.gemMsg, role: 'assistant', text: '', done: false });
        }
        delta(a, a.gemMsg, m.content);
        return false;
      }
      case 'tool_use': {
        closeMessage(a);
        const name = GEMINI_TOOL[m.tool_name] || String(m.tool_name || 'tool');
        const id = `${a.id}:${a.turnNo}:${m.tool_id}`;
        a.starts.set(id, Date.now());
        put(a, { k: 'tool', id, name, summary: summarize(name, m.parameters || {}), detail: trimDeep(m.parameters || {}), status: 'running' });
        pushMeta(a);
        return false;
      }
      case 'tool_result': {
        const id = `${a.id}:${a.turnNo}:${m.tool_id}`;
        const started = a.starts.get(id);
        put(a, { k: 'tool', id, status: m.status === 'error' ? 'error' : 'done', output: trunc(String(m.output ?? m.error?.message ?? ''), MAX_OUT), ms: started ? Date.now() - started : undefined });
        pushMeta(a);
        return false;
      }
      case 'error':
        if (m.severity === 'error') fail(a, String(m.message || 'Gemini reported an error'));
        else note(a, String(m.message || ''));
        return false;
      case 'result': {
        closeMessage(a);
        const ok = m.status === 'success';
        const s = m.stats || {};
        a.stats.tokens.fresh += Number(s.input_tokens) || 0;
        a.stats.tokens.cached += Number(s.cached) || Number(s.cached_input_tokens) || 0;
        a.stats.tokens.out += Number(s.output_tokens) || 0;
        a.busy = false;
        a.turns += 1;
        endTurnCleanup(a, 'Ended');
        if (!ok && m.error?.message) fail(a, String(m.error.message));
        put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok, ms: Number(s.duration_ms) || undefined });
        pushMeta(a);
        return true;
      }
      default:
        return false;
    }
  }

  return { send };
}
