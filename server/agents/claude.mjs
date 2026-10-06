// Claude Code, driven as one live process over stream-json:
//   claude -p --input-format stream-json --output-format stream-json
// Messages go in on stdin; text, tool calls, approval requests and results come back on stdout.

import { spawn } from 'node:child_process';
import { CLAUDE_MODE_FLAG, MAX_OUT } from './constants.mjs';
import { cleanEnv, stringifyContent, trimDeep, trunc } from './util.mjs';

/** `ctx` supplies the shared pieces: cwd, specs, environment, denyTool, summarize and the event helpers. */
export function createClaude(ctx) {
  const { cwd, specs, environment, denyTool, summarize, put, delta, note, fail, fx, pushMeta, endTurnCleanup, planFromTool } = ctx;

  function ensure(a) {
    if (a.proc) return a.proc;
    const args = [
      ...specs.claude.args,
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', CLAUDE_MODE_FLAG[a.mode],
    ];
    if (a.modelPref) args.push('--model', a.modelPref);
    if (a.effort) args.push('--effort', a.effort);
    if (a.sessionId) args.push('--resume', a.sessionId);
    const proc = spawn(specs.claude.file, args, { cwd, env: { ...cleanEnv(), ...environment, ...specs.claude.environment }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    a.proc = proc;
    a.lastTotal = 0;
    a.stderr = '';
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (proc.__quiet || a.proc !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(a, line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => (a.stderr = (a.stderr + d).slice(-2000)));
    proc.on('error', (e) => {
      if (proc.__quiet || a.proc !== proc) return;
      fail(a, `Could not start Claude Code: ${e.message}`);
      a.proc = null;
      a.busy = false;
      pushMeta(a);
    });
    proc.on('exit', (code) => {
      if (a.proc === proc) a.proc = null;
      if (proc.__quiet) return;
      if (a.busy) {
        a.busy = false;
        endTurnCleanup(a, 'Claude exited');
        fail(a, `Claude Code stopped unexpectedly (exit ${code}).${a.stderr ? '\n' + trunc(a.stderr.trim(), 600) : ''}`);
      }
      pushMeta(a);
    });
    return proc;
  }

  function onLine(a, line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          a.sessionId = m.session_id || a.sessionId;
          a.model = m.model || a.model;
          if (Array.isArray(m.mcp_servers)) a.stats.mcp = m.mcp_servers.map((s) => ({ name: String(s.name).replace(/^claude\.ai /, ''), status: s.status }));
          pushMeta(a);
        } else if (m.subtype === 'compact_boundary') {
          a.stats.compactions += 1;
          a.stats.ctxUsed = Math.min(a.stats.ctxUsed, Math.round((m.compact_metadata?.post_tokens || 0) || a.stats.ctxUsed * 0.15));
          note(a, 'Context was compacted to make room.');
          fx(a, 'compact');
          pushMeta(a);
        }
        break;
      case 'stream_event':
        onStream(a, m.event || {});
        break;
      case 'assistant':
        onAssistant(a, m);
        break;
      case 'user':
        onUser(a, m);
        break;
      case 'control_request':
        onControl(a, m);
        break;
      case 'rate_limit_event': {
        const w = m.rate_limit_info?.unifiedWindows || {};
        const conv = (x) => (x ? { u: Number(x.utilization) || 0, reset: Number(x.resetsAt) || 0 } : null);
        a.stats.limits = { five: conv(w.five_hour) || a.stats.limits.five, seven: conv(w.seven_day) || a.stats.limits.seven };
        pushMeta(a);
        break;
      }
      case 'result':
        onResult(a, m);
        break;
    }
  }

  function noteUsage(a, usage, withOutput) {
    if (!usage) return;
    const fresh = Number(usage.input_tokens) || 0;
    const cread = Number(usage.cache_read_input_tokens) || 0;
    const cnew = Number(usage.cache_creation_input_tokens) || 0;
    const total = fresh + cread + cnew;
    if (total > 0) {
      a.stats.ctxUsed = total + (withOutput ? Number(usage.output_tokens) || 0 : 0);
      a.stats.cache = cread / total;
    }
  }

  function onStream(a, e) {
    if (e.type === 'message_start') {
      a.curMsg = e.message?.id;
      a.streamed.add(a.curMsg);
      a.blocks = new Map();
      noteUsage(a, e.message?.usage, false);
      pushMeta(a);
      return;
    }
    const idx = e.index;
    const id = `${a.id}:${a.curMsg}:${idx}`;
    if (e.type === 'content_block_start') {
      const b = e.content_block || {};
      if (b.type === 'text') {
        put(a, { k: 'msg', id, role: 'assistant', text: '', done: false });
        a.blocks.set(idx, { type: 'text', id });
      } else if (b.type === 'thinking') {
        put(a, { k: 'think', id, text: '', done: false });
        a.blocks.set(idx, { type: 'thinking', id });
        a.stats.thinking = true;
        pushMeta(a);
      } else if (b.type === 'tool_use') {
        a.starts.set(b.id, Date.now());
        put(a, { k: 'tool', id: b.id, name: b.name, summary: '', status: 'running' });
        a.blocks.set(idx, { type: 'tool', id: b.id, name: b.name, json: '' });
        pushMeta(a);
      }
    } else if (e.type === 'content_block_delta') {
      const blk = a.blocks.get(idx);
      const d = e.delta || {};
      if (!blk) return;
      if (d.type === 'text_delta' && blk.type === 'text') delta(a, blk.id, d.text || '');
      else if (d.type === 'thinking_delta' && blk.type === 'thinking') delta(a, blk.id, d.thinking || '');
      else if (d.type === 'input_json_delta' && blk.type === 'tool') blk.json += d.partial_json || '';
    } else if (e.type === 'content_block_stop') {
      const blk = a.blocks.get(idx);
      if (!blk) return;
      if (blk.type === 'text') put(a, { k: 'msg', id: blk.id, done: true });
      else if (blk.type === 'thinking') {
        put(a, { k: 'think', id: blk.id, done: true });
        a.stats.thinking = false;
        pushMeta(a);
      } else if (blk.type === 'tool') {
        let input = {};
        try {
          input = JSON.parse(blk.json || '{}');
        } catch {
          /* partial input; the full assistant message will fill it in */
        }
        put(a, { k: 'tool', id: blk.id, summary: summarize(blk.name, input), detail: trimDeep(input) });
        planFromTool(a, blk.id, blk.name, input);
      }
    }
  }

  function onAssistant(a, m) {
    const msg = m.message || {};
    if (!m.parent_tool_use_id) noteUsage(a, msg.usage, true);
    const streamed = a.streamed.has(msg.id);
    (msg.content || []).forEach((b, i) => {
      if (b.type === 'tool_use') {
        const exists = a.index.has(b.id);
        if (!a.starts.has(b.id)) a.starts.set(b.id, Date.now());
        put(a, { k: 'tool', id: b.id, name: b.name, summary: summarize(b.name, b.input), detail: trimDeep(b.input), ...(exists ? {} : { status: 'running' }) });
        planFromTool(a, b.id, b.name, b.input);
      } else if (!streamed && b.type === 'text') {
        put(a, { k: 'msg', id: `${a.id}:${msg.id}:a${i}`, role: 'assistant', text: b.text || '', done: true });
      } else if (!streamed && b.type === 'thinking') {
        put(a, { k: 'think', id: `${a.id}:${msg.id}:a${i}`, text: b.thinking || '', done: true });
      }
    });
    pushMeta(a);
  }

  function onUser(a, m) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const started = a.starts.get(b.tool_use_id);
      put(a, {
        k: 'tool',
        id: b.tool_use_id,
        status: b.is_error ? 'error' : 'done',
        output: trunc(stringifyContent(b.content), MAX_OUT),
        ms: started ? Date.now() - started : undefined,
      });
    }
    pushMeta(a);
  }

  const reply = (a, response) => a.proc?.stdin?.writable && a.proc.stdin.write(JSON.stringify({ type: 'control_response', response }) + '\n');

  function onControl(a, m) {
    const r = m.request || {};
    if (r.subtype === 'can_use_tool' && denyTool(r.tool_name)) {
      // The app, not the model, decides when a locked agent may leave read-only work.
      reply(a, { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: String(denyTool(r.tool_name)) } });
      return;
    }
    if (r.subtype === 'can_use_tool') {
      a.approvals.set(m.request_id, { input: r.input, toolUseId: r.tool_use_id });
      put(a, {
        k: 'tool',
        id: r.tool_use_id,
        name: r.tool_name,
        summary: summarize(r.tool_name, r.input),
        detail: trimDeep(r.input),
        status: 'awaiting',
        requestId: m.request_id,
      });
      pushMeta(a);
    } else {
      // Anything else the CLI asks of its host is declined rather than left hanging.
      reply(a, { subtype: 'error', request_id: m.request_id, error: 'Not supported by Tandem' });
    }
  }

  function onResult(a, m) {
    a.busy = false;
    const total = Number(m.total_cost_usd) || 0;
    const cost = Math.max(0, total - a.lastTotal);
    a.lastTotal = total;
    a.cost += cost;
    a.turns += 1;
    const u = m.usage || {};
    a.stats.tokens.fresh += Number(u.input_tokens) || 0;
    a.stats.tokens.cached += (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    a.stats.tokens.out += Number(u.output_tokens) || 0;
    a.stats.tokens.think += Number(u.output_tokens_details?.thinking_tokens) || 0;
    const mu = m.modelUsage && Object.values(m.modelUsage)[0];
    if (mu?.contextWindow) a.stats.ctxWindow = mu.contextWindow;
    for (const d of m.permission_denials || []) if (d.tool_use_id) put(a, { k: 'tool', id: d.tool_use_id, status: 'denied' });
    endTurnCleanup(a, 'Ended');
    if (m.is_error && m.result) fail(a, String(m.result));
    put(a, { k: 'turn', id: `${a.id}:t${++a.seq}`, ok: !m.is_error, ms: m.duration_ms, cost, steps: m.num_turns });
    pushMeta(a);
  }

  /** Keep only string answers keyed by question text, so a client cannot inject other tool input. */
  function cleanAnswers(input, answers) {
    if (!Array.isArray(input?.questions) || !answers || typeof answers !== 'object') return null;
    const out = {};
    for (const q of input.questions) {
      const v = answers[q.question];
      if (typeof v === 'string' && v.trim()) out[q.question] = v.slice(0, 2000);
    }
    return Object.keys(out).length ? out : null;
  }

  /** Answer an approval card. Returns the answers that were accepted (for selection cards), or null. */
  function decide(a, requestId, allow, answers) {
    const ap = a.approvals.get(requestId);
    if (!ap || !a.proc?.stdin?.writable) return null;
    const picked = allow ? cleanAnswers(ap.input, answers) : null;
    const response = allow
      ? { behavior: 'allow', updatedInput: picked ? { ...ap.input, answers: picked } : ap.input }
      : { behavior: 'deny', message: 'The user declined this action in Tandem.' };
    reply(a, { subtype: 'success', request_id: requestId, response });
    a.approvals.delete(requestId);
    put(a, { k: 'tool', id: ap.toolUseId, status: allow ? 'running' : 'denied' });
    pushMeta(a);
    return picked;
  }

  return { ensure, decide };
}
