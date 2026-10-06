// Codex CLI, one process per turn:  codex exec --json [resume <id>]
// Context size and account limits are not in its output, so they are read from Codex's own session files.

import { spawn } from 'node:child_process';
import { CODEX_SANDBOX, MAX_OUT } from './constants.mjs';
import { findRollout, lastTokenCount, newestRollout } from './codex-usage.mjs';
import { cleanEnv, trimDeep, trunc } from './util.mjs';

/** `ctx` supplies the shared pieces: cwd, specs, environment, rel, agents and the event helpers. */
export function createCodex(ctx) {
  const { cwd, specs, environment, rel, agents, put, fail, pushMeta, endTurnCleanup } = ctx;

  /** Pull context size and account limits from Codex's own session records. */
  function poll(a) {
    const file = (a.sessionId && (a.rollout || (a.rollout = findRollout(a.sessionId)))) || null;
    const own = file ? lastTokenCount(file) : null;
    const any = own || (() => {
      const f = newestRollout();
      return f ? lastTokenCount(f) : null;
    })();
    if (!any) return;
    let changed = false;
    if (own?.info) {
      const last = own.info.last_token_usage || {};
      const used = Number(last.total_tokens) || (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
      if (used !== a.stats.ctxUsed) changed = true;
      a.stats.ctxUsed = used;
      if (own.info.model_context_window) a.stats.ctxWindow = own.info.model_context_window;
      const input = Number(last.input_tokens) || 0;
      a.stats.cache = input ? (Number(last.cached_input_tokens) || 0) / input : 0;
    } else if (any.info?.model_context_window && !a.sessionId) {
      a.stats.ctxWindow = any.info.model_context_window;
    }
    const rl = any.rate_limits;
    if (rl) {
      const conv = (x) => (x ? { u: (Number(x.used_percent) || 0) / 100, reset: Number(x.resets_at) || 0 } : null);
      const next = { five: conv(rl.primary), seven: conv(rl.secondary) };
      if (JSON.stringify(next) !== JSON.stringify(a.stats.limits)) changed = true;
      a.stats.limits = next;
    }
    if (changed) pushMeta(a);
  }

  let turnPoll = null;
  function startPolling(a) {
    clearInterval(turnPoll);
    turnPoll = setInterval(() => poll(a), 1500);
  }
  function stopPolling(a) {
    clearInterval(turnPoll);
    turnPoll = null;
    setTimeout(() => poll(a), 600);
  }
  // Limits are account-wide, so show them even before the first message.
  const initialPoll = setTimeout(() => agents.codex && poll(agents.codex), 800);
  const idlePoll = setInterval(() => agents.codex && !agents.codex.busy && poll(agents.codex), 30000);
  idlePoll.unref();

  function send(a, text, images = []) {
    const args = [...specs.codex.args, 'exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', CODEX_SANDBOX[a.mode]];
    if (a.modelPref) args.push('-m', a.modelPref);
    if (a.effort) args.push('-c', `model_reasoning_effort="${a.effort}"`);
    if (a.sessionId) args.push('resume', a.sessionId);
    for (const image of images) args.push('--image', image.path);
    args.push('-');
    const proc = spawn(specs.codex.file, args, { cwd, env: { ...cleanEnv(), ...environment, ...specs.codex.environment }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.stderr = '';
    startPolling(a);
    let buf = '';
    let sawTurnEnd = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (proc.__quiet || a.proc !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line && onLine(a, line)) sawTurnEnd = true;
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (a.stderr = (a.stderr + d).slice(-2000)));
    proc.on('error', (e) => {
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start Codex: ${e.message}`);
      a.proc = null;
      a.busy = false;
      stopPolling(a);
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      if (a.proc === proc) a.proc = null;
      stopPolling(a);
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        endTurnCleanup(a, 'Codex exited');
        if (!sawTurnEnd) {
          const hint = a.stderr.trim().split('\n').filter((l) => !/Reading prompt from stdin/i.test(l)).slice(-6).join('\n');
          fail(a, `Codex stopped${code ? ` (exit ${code})` : ''} before finishing.${hint ? '\n' + trunc(hint, 700) : ''}`);
        }
      }
      pushMeta(a);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(text);
  }

  /** Returns true when the line ended a turn. */
  function onLine(a, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return false;
    }
    const it = m.item || {};
    const id = it.id ? `${a.id}:${it.id}:${a.turnNo}` : null;
    switch (m.type) {
      case 'thread.started':
        a.sessionId = m.thread_id || a.sessionId;
        a.rollout = null;
        pushMeta(a);
        return false;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const done = m.type === 'item.completed';
        switch (it.type) {
          case 'agent_message':
            if (id) put(a, { k: 'msg', id, role: 'assistant', text: it.text || '', done });
            break;
          case 'reasoning':
            if (id) put(a, { k: 'think', id, text: it.text || '', done });
            if (a.stats.thinking === done) {
              a.stats.thinking = !done;
              pushMeta(a);
            }
            break;
          case 'command_execution': {
            if (!a.starts.has(id)) a.starts.set(id, Date.now());
            const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0);
            put(a, {
              k: 'tool',
              id,
              name: 'Shell',
              summary: trunc(String(it.command || '').replace(/^(?:\S*[\\/])?(?:bash|sh|zsh|powershell|pwsh)(?:\.exe)?\s+-\w*c\w*\s+/i, ''), 200),
              status: done ? (failed ? 'error' : 'done') : 'running',
              output: it.aggregated_output ? trunc(it.aggregated_output, MAX_OUT) : undefined,
              ms: done ? Date.now() - a.starts.get(id) : undefined,
            });
            break;
          }
          case 'file_change': {
            const files = (it.changes || []).map((c) => `${c.kind || 'edit'} ${rel(c.path)}`);
            put(a, { k: 'tool', id, name: 'Edit', summary: trunc(files.join(', '), 200), detail: { changes: it.changes }, status: done ? (it.status === 'failed' ? 'error' : 'done') : 'running' });
            break;
          }
          case 'mcp_tool_call':
            put(a, { k: 'tool', id, name: `${it.server || 'mcp'}.${it.tool || 'tool'}`, summary: '', detail: trimDeep(it.arguments), status: done ? (it.status === 'failed' ? 'error' : 'done') : 'running' });
            break;
          case 'web_search':
            put(a, { k: 'tool', id, name: 'Search', summary: it.query || '', status: done ? 'done' : 'running' });
            break;
          case 'todo_list':
          case 'plan':
            put(a, { k: 'plan', id, items: (it.items || []).map((x) => ({ text: x.text, done: !!x.completed })) });
            break;
          case 'error':
            fail(a, it.message || 'Codex reported an error');
            break;
        }
        pushMeta(a);
        return false;
      }
      case 'turn.completed': {
        a.busy = false;
        a.turns += 1;
        a.stats.thinking = false;
        const u = m.usage || {};
        a.stats.tokens.fresh += Math.max(0, (Number(u.input_tokens) || 0) - (Number(u.cached_input_tokens) || 0));
        a.stats.tokens.cached += Number(u.cached_input_tokens) || 0;
        a.stats.tokens.out += Number(u.output_tokens) || 0;
        a.stats.tokens.think += Number(u.reasoning_output_tokens) || 0;
        put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: true, tokens: { in: u.input_tokens, out: u.output_tokens } });
        pushMeta(a);
        return true;
      }
      case 'turn.failed':
        a.busy = false;
        endTurnCleanup(a, 'Turn failed');
        fail(a, m.error?.message || 'The turn failed');
        put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: false });
        pushMeta(a);
        return true;
      case 'error':
        fail(a, m.message || 'Codex reported an error');
        return false;
    }
    return false;
  }

  return {
    send,
    stopPolling,
    close() {
      clearTimeout(initialPoll);
      clearInterval(idlePoll);
      clearInterval(turnPoll);
    },
  };
}
