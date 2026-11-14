// Google Antigravity CLI (`agy`), one process per turn:  agy --output-format stream-json --mode ... -p=<task>
// Events come back as JSON lines (read from a real run of agy 1.5.8):
//   {event:"init", conversation_id, init:{cwd, tools, permission_mode}}
//   {event:"step_update", step_update:{step_index, state:"ACTIVE"|"DONE", step_type:"user_input"|"agent_response"|"tool",
//      text_delta?, tool_name?, tool_info?:{name, parameters, output?}, duration_seconds?, usage?}}
//   {event:"result", result:{status:"SUCCESS"|..., response, duration_seconds, usage}}
// Only that one successful, read-only turn was observed. Failure states and error events are handled by pattern, defensively.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ANTIGRAVITY_MODE, MAX_OUT } from './constants.mjs';
import { ANTIGRAVITY_TOOL } from './tools.mjs';
import { cleanEnv, trimDeep, trunc } from './util.mjs';

const AUTH = /(auth|credential|login|log in|sign in|oauth|permission_denied|unauthenticated)/i;
const BAD = /ERR|FAIL|CANCEL|DENIED|REJECT/i;
const MAX_ARG = 20000; // a Windows command line holds about 32,000 characters; longer tasks go through a file

/** Antigravity names its parameters in PascalCase (Path, CommandLine). The chat's summaries expect Claude-style keys. */
export function antigravityInput(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) out[k] = v;
  const pick = (...keys) => keys.map((k) => params?.[k]).find((v) => typeof v === 'string' && v);
  const file = pick('Path', 'AbsolutePath', 'TargetFile', 'File', 'FilePath', 'DirectoryPath', 'SearchPath');
  const command = pick('CommandLine', 'Command');
  const query = pick('Query', 'Pattern', 'SearchTerm');
  const url = pick('Url', 'URL');
  if (file) out.file_path = file;
  if (command) out.command = command;
  if (query) { out.query = query; out.pattern = query; }
  if (url) out.url = url;
  return out;
}

export function createAntigravity(ctx) {
  const { cwd, specs, environment, summarize, put, delta, note, fail, pushMeta, endTurnCleanup } = ctx;

  function closeMessage(a) {
    if (a.agyMsg) put(a, { k: 'msg', id: a.agyMsg, done: true });
    a.agyMsg = null;
  }

  function send(a, text, images = []) {
    const spec = specs.antigravity;
    const mode = ANTIGRAVITY_MODE[a.mode] || ANTIGRAVITY_MODE.plan;
    const args = [...spec.args, '--output-format', 'stream-json', '--mode', mode.mode, ...(mode.skip ? ['--dangerously-skip-permissions'] : [])];
    if (mode.allow) args.push('--settings', JSON.stringify({ permissions: { allow: mode.allow } })); // this session only; never saved
    if (a.modelPref) args.push('--model', a.modelPref);
    if (a.effort) args.push('--effort', a.effort);
    if (a.sessionId) args.push('--conversation', a.sessionId);
    let task = text + (images.length ? `\n\nAttached images (read these files): ${images.map((i) => i.path).join(', ')}` : '');
    let taskFile = null;
    if (task.length > MAX_ARG) {
      taskFile = path.join(os.tmpdir(), `tandem-task-${process.pid}-${Date.now()}.md`);
      fs.writeFileSync(taskFile, task);
      task = `Your task is written in the file ${taskFile}. Read that file first, then carry it out.`;
    }
    args.push(`-p=${task}`);
    const proc = spawn(spec.file, args, { cwd, env: { ...cleanEnv(), ...environment, ...spec.environment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.stderr = '';
    a.agyMsg = null;
    a.agyStreamed = false;
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
    const cleanup = () => { if (taskFile) fs.rm(taskFile, { force: true }, () => {}); };
    proc.on('error', (e) => {
      cleanup();
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start the Antigravity CLI: ${e.message}`);
      a.proc = null;
      a.busy = false;
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      cleanup();
      if (a.proc === proc) a.proc = null;
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        closeMessage(a);
        endTurnCleanup(a, 'Antigravity exited');
        if (!sawResult) {
          const hint = a.stderr.trim().split('\n').slice(-6).join('\n');
          const auth = AUTH.test(hint) ? ' It may not be signed in: open Connect agents and press Sign in for Antigravity CLI.' : '';
          fail(a, `Antigravity stopped${code ? ` (exit ${code})` : ''} before finishing.${auth}${hint ? '\n' + trunc(hint, 700) : ''}`);
        }
      }
      pushMeta(a);
    });
  }

  function addUsage(a, u) {
    if (!u) return;
    a.stats.tokens.fresh += Number(u.input_tokens) || 0;
    a.stats.tokens.cached += Number(u.cache_read_tokens) || 0;
    a.stats.tokens.out += Number(u.output_tokens) || 0;
    if ('think' in a.stats.tokens) a.stats.tokens.think += Number(u.thinking_tokens) || 0;
  }

  /** Returns true when the line ended the turn. */
  function onLine(a, line) {
    let m;
    try { m = JSON.parse(line); } catch { return false; }
    if (m.event === 'init') {
      a.sessionId = m.conversation_id || a.sessionId;
      pushMeta(a);
      return false;
    }
    if (m.event === 'step_update' && m.step_update) {
      const s = m.step_update;
      if (s.step_type === 'agent_response') {
        if (typeof s.text_delta === 'string' && s.text_delta) {
          if (!a.agyMsg) {
            a.agyMsg = `${a.id}:${a.turnNo}:m${++a.seq}`;
            put(a, { k: 'msg', id: a.agyMsg, role: 'assistant', text: '', done: false });
          }
          a.agyStreamed = true;
          delta(a, a.agyMsg, s.text_delta);
        }
        if (s.state === 'DONE') { closeMessage(a); addUsage(a, s.usage); pushMeta(a); }
      } else if (s.step_type === 'tool') {
        closeMessage(a);
        const raw = s.tool_info?.name || s.tool_name || 'tool';
        const name = ANTIGRAVITY_TOOL[raw] || String(raw);
        const id = `${a.id}:${a.turnNo}:s${s.step_index}`;
        if (s.state === 'ACTIVE') {
          const input = antigravityInput(s.tool_info?.parameters);
          put(a, { k: 'tool', id, name, summary: summarize(name, input), detail: trimDeep(input), status: 'running' });
        } else {
          const failed = BAD.test(String(s.state || ''));
          put(a, { k: 'tool', id, status: failed ? 'error' : 'done', output: trunc(String(s.tool_info?.output ?? s.tool_info?.error ?? ''), MAX_OUT), ms: s.duration_seconds ? Math.round(s.duration_seconds * 1000) : undefined });
        }
        pushMeta(a);
      }
      return false;
    }
    if (m.event === 'error') {
      fail(a, String(m.error?.message || m.message || 'Antigravity reported an error'));
      return false;
    }
    if (m.event === 'result' && m.result) {
      const r = m.result;
      closeMessage(a);
      const ok = r.status === 'SUCCESS';
      // A reply that was not streamed step by step still arrives here in full.
      if (!a.agyStreamed && typeof r.response === 'string' && r.response.trim()) put(a, { k: 'msg', id: `${a.id}:${a.turnNo}:m${++a.seq}`, role: 'assistant', text: r.response, done: true });
      a.sessionId = r.conversation_id || a.sessionId;
      a.busy = false;
      a.turns += 1;
      endTurnCleanup(a, 'Ended');
      if (!ok) fail(a, String(r.error?.message || r.error || `Antigravity ended with status ${r.status || 'unknown'}.`));
      // Headless Antigravity cannot ask for permission, so anything that would need asking is refused. Say so plainly.
      const denied = Array.isArray(r.denied_actions) ? [...new Set(r.denied_actions.map((d) => String(d.display_name || d.action || 'an action')))] : [];
      if (denied.length) fail(a, `Antigravity was not allowed to run ${denied.join(', ')} in ${a.mode === 'plan' ? 'Plan' : a.mode === 'auto' ? 'Auto' : 'Edit'} mode: it cannot ask for permission from Tandem, so it refused. To let it run commands, allow Full access in Settings and switch it to Full access (not sandboxed).`);
      put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok, ms: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined });
      pushMeta(a);
      return true;
    }
    if (m.event && m.message && typeof m.message === 'string') note(a, m.message);
    return false;
  }

  return { send, onLine };
}
