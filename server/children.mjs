import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createAgents, validModel } from './agents.mjs';

const ACTIVE = new Set(['queued', 'running']);
const safeId = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function json(file, limit = 4 * 1024 * 1024) {
  try { if (fs.statSync(file).size <= limit) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return null;
}
function tail(file, limit = 160000) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(Math.min(limit, size)); fs.readSync(fd, buf, 0, buf.length, size - buf.length); return (size > limit ? '[Earlier activity omitted]\n' : '') + buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}

export function pluginStateDirs(cwd, roots) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch {}
  const slug = path.basename(cwd).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  return roots.map((root) => path.join(root, `${slug}-${hash(real)}`));
}

// Read the installed plugin's records without changing its files or controlling its process.
export function readPluginJobs(cwd, roots) {
  const jobs = [];
  for (const dir of pluginStateDirs(cwd, roots)) {
    for (const record of json(path.join(dir, 'state.json'))?.jobs || []) {
      if (!safeId(record.id) || typeof record.sessionId !== 'string') continue;
      const stored = json(path.join(dir, 'jobs', `${record.id}.json`)) || {};
      jobs.push({ ...stored, ...record, result: stored.result, rendered: stored.rendered,
        activity: tail(path.join(dir, 'jobs', `${record.id}.log`)), sourceKey: hash(dir + record.id) });
    }
  }
  return jobs;
}

export function createChildren({ root, specs, getCwd, getParents, broadcast, pluginRoots, pollMs = 1500, getInstructions = () => '' }) {
  const file = path.join(root, '.tandem', 'children.json');
  const children = new Map();
  let timer, saveTimer, closed = false;
  const roots = pluginRoots || [
    ...(process.env.CLAUDE_PLUGIN_DATA ? [path.join(process.env.CLAUDE_PLUGIN_DATA, 'state')] : []),
    path.join(os.homedir(), '.claude', 'plugins', 'data', 'codex-openai-codex', 'state'),
    path.join(os.tmpdir(), 'codex-companion'),
  ];
  const parentOf = (c) => getParents().find((p) => p.id === c.parentId && p.key === c.parentKey && c.cwd === getCwd());
  const visible = (c) => !!parentOf(c);
  function save() {
    if (closed) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const records = [...children.values()].map(({ cli, fingerprint, ...c }) => ({ ...c, state: cli ? cli.save()[c.provider] : c.state }));
    fs.writeFileSync(file + '.tmp', JSON.stringify(records)); fs.renameSync(file + '.tmp', file);
  }
  function schedule() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { save(); } catch (e) { console.error('Could not save child chats:', e.message); } }, 300); }
  function snapshot(c) {
    const snap = c.cli?.snapshot()[c.provider];
    return { id: c.id, parentId: c.parentId, parentKey: c.parentKey, provider: c.provider, title: c.title,
      source: c.source, threadId: c.cli?.save()[c.provider]?.sessionId || c.state?.sessionId || null, updatedAt: c.updatedAt,
      events: snap?.events || c.state?.events || [],
      meta: { ...(snap?.meta || { available: !!specs[c.provider], mode: c.state?.mode || 'read', modelPref: c.state?.modelPref || null }),
        busy: !!snap?.meta.busy || !!c.externalBusy, external: !!c.externalBusy, status: c.status,
        resumable: !c.externalBusy && (c.source !== 'plugin' || !!c.state?.sessionId) } };
  }
  function publish(c) { c.updatedAt = Date.now(); if (visible(c)) broadcast({ t: 'child', child: snapshot(c) }); schedule(); }
  function attach(c) {
    if (c.cli) return;
    c.cli = createAgents({ cwd: c.cwd, specs, providers: [c.provider], getInstructions: () => getInstructions(c.provider), broadcast(msg) {
      if (closed) return;
      c.updatedAt = Date.now();
      if (msg.t === 'ev' && msg.ev.k === 'turn') c.status = msg.ev.ok === false ? 'failed' : 'completed';
      if (msg.t === 'meta' && msg.meta.busy) c.status = 'running';
      if (visible(c)) {
        if (msg.t === 'ev') broadcast({ t: 'child-event', id: c.id, ev: msg.ev, updatedAt: c.updatedAt });
        if (msg.t === 'meta' || msg.t === 'reset') publish(c);
      }
      schedule();
    } });
    if (c.state) c.cli.restore({ [c.provider]: c.state });
  }
  const saved = json(file);
  for (const c of Array.isArray(saved) ? saved : []) {
    if (!safeId(c.id) || !['claude', 'codex'].includes(c.provider)) continue;
    if (ACTIVE.has(c.status) && c.source !== 'plugin') {
      c.status = 'interrupted';
      c.state ||= { events: [] }; c.state.events ||= [];
      c.state.events.push({ k: 'note', id: `${c.id}-interrupted`, text: 'Tandem restarted. Send a message to continue this task.' });
    }
    children.set(c.id, c);
  }
  function create(parentId, { provider, text, model = null, title } = {}) {
    const parent = getParents().find((p) => p.id === parentId);
    if (!parent) throw new Error('Select a main chat first.');
    if (!['claude', 'codex'].includes(provider) || !specs[provider]) throw new Error('That CLI is not installed.');
    if (typeof text !== 'string' || !text.trim() || text.length > 40000) throw new Error('Enter a task of up to 40,000 characters.');
    if (model && !validModel(model)) throw new Error('Invalid model name.');
    if ([...children.values()].filter((c) => visible(c)).length >= 40) throw new Error('This conversation has reached its 40 child chat limit. Start a new main chat.');
    const id = `child-${crypto.randomBytes(8).toString('hex')}`;
    const c = { id, parentId, parentKey: parent.key, cwd: getCwd(), provider, source: 'tandem',
      title: String(title || text).replace(/\s+/g, ' ').slice(0, 100), status: 'running', updatedAt: Date.now(),
      state: { events: [], mode: provider === 'claude' ? 'plan' : 'read', modelPref: model } };
    children.set(id, c); attach(c); publish(c);
    c.cli.send(provider, text); return snapshot(c);
  }
  function action(m) {
    const c = children.get(m.id);
    if (!c || !visible(c)) throw new Error('This child chat belongs to a different conversation.');
    if (c.externalBusy) throw new Error('Claude is still running this plugin task. Wait for it to finish before replying here.');
    if (c.source === 'plugin' && !c.state?.sessionId) throw new Error('This review has no saved thread. Start a new child task to follow up.');
    if (m.action === 'send' && (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 40000)) throw new Error('Enter a message of up to 40,000 characters.');
    attach(c);
    const method = { send: 'send', stop: 'stop', mode: 'setMode', model: 'setModel', effort: 'setEffort', approve: 'approve' }[m.action];
    if (!method) throw new Error('Unknown child chat action.');
    if (m.action === 'stop') c.status = 'interrupted';
    c.cli[method](c.provider, m.text ?? m.mode ?? m.model ?? m.effort ?? m.requestId, m.allow === true);
    publish(c); return snapshot(c);
  }
  function poll() {
    if (closed) return;
    for (const job of readPluginJobs(getCwd(), roots)) {
      const parent = getParents().find((p) => p.provider === 'claude' && p.sessionId === job.sessionId);
      if (!parent) continue;
      const id = `plugin-${job.sourceKey}`;
      let c = children.get(id);
      const externalBusy = ACTIVE.has(job.status) && alive(job.pid);
      const fingerprint = hash(JSON.stringify([job.status, externalBusy, job.threadId, job.activity, job.result, job.errorMessage]));
      if (c?.fingerprint === fingerprint || c?.cli?.snapshot()[c.provider].meta.busy) continue;
      if (!c) {
        c = { id, parentId: parent.id, parentKey: parent.key, cwd: getCwd(), provider: 'codex', source: 'plugin', title: String(job.summary || job.title || 'Codex task').slice(0, 100), state: { events: [], mode: 'read' } };
        children.set(id, c);
      }
      c.fingerprint = fingerprint; c.externalBusy = externalBusy; c.status = ACTIVE.has(job.status) && !externalBusy ? 'interrupted' : job.status;
      if (job.threadId && /^[a-zA-Z0-9_-]{1,100}$/.test(job.threadId)) c.state.sessionId = job.threadId;
      const events = [{ k: 'user', id: `${id}-task`, text: job.request?.prompt || job.summary || job.title || 'Delegated by Claude' }];
      if (job.activity) events.push({ k: 'tool', id: `${id}-activity`, name: 'Activity', summary: 'Claude → Codex task log', output: job.activity, status: c.externalBusy ? 'running' : job.status === 'failed' ? 'error' : 'done' });
      const answer = job.result?.rawOutput || job.rendered;
      if (typeof answer === 'string' && answer) events.push({ k: 'msg', id: `${id}-answer`, text: answer, done: true });
      if (job.errorMessage) events.push({ k: 'error', id: `${id}-error`, text: String(job.errorMessage) });
      if (c.cli) { c.state = c.cli.save()[c.provider]; c.cli.closeAll(); c.cli = null; }
      // Preserve any follow-up messages already sent in Tandem.
      const previous = (c.state.events || []).filter((e) => !e.id?.startsWith(id + '-'));
      c.state.events = [...events, ...previous]; publish(c);
    }
  }
  timer = setInterval(poll, pollMs); timer.unref();
  return {
    create, action, poll,
    snapshot: () => [...children.values()].filter(visible).map(snapshot),
    busy: () => [...children.values()].some((c) => c.cwd === getCwd() && (c.externalBusy || c.cli?.snapshot()[c.provider].meta.busy)),
    stopAll() { for (const c of children.values()) if (c.cli) { c.cli.stop(c.provider); c.status = 'interrupted'; publish(c); } },
    close() { clearInterval(timer); clearTimeout(saveTimer); try { save(); } catch {} closed = true; for (const c of children.values()) c.cli?.closeAll(); },
  };
}
