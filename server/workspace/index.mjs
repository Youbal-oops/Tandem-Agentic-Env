// One workspace = the open repository plus the "planets" (main agents) working in it.
// This file owns the shared state and the public API. The parts live next to it:
//   prompt.mjs    standing instructions         history.mjs   saved conversations
//   api-chat.mjs  API-backed planets            repos.mjs     switching repositories, removing planets
//   ../learning/  learner profile, learning mode, checkpoints and the journal

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgents, validModel } from '../agents.mjs';
import { createChildren } from '../children.mjs';
import { createImageStore } from '../images.mjs';
import { createWorktrees } from '../worktrees.mjs';
import { ensureProjectContext } from '../project-context.mjs';
import { createLearning } from '../learning/session.mjs';
import { createApiChat } from './api-chat.mjs';
import { createHistory } from './history.mjs';
import { createPrompt } from './prompt.mjs';
import { createRepoSwitcher } from './repos.mjs';

// One CLI adapter per planet, so two Codex/Claude planets never share a thread.
export function createWorkspace({ root, cwd, specs, broadcast, fetchImpl = fetch, getAgentContext = () => ({}), pluginRoots, childPollMs }) {
  const dir = path.join(root, '.tandem');
  const file = path.join(dir, 'workspace.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}

  const entries = new Map();
  let children;
  let timer;
  const startDir = fs.existsSync(saved.cwd || '') ? saved.cwd : cwd;

  // State shared with the parts. `workingDir` and `projectContext` change when the repository does.
  const ctx = {
    root, dir, specs, saved, entries, broadcast, fetchImpl,
    images: createImageStore(root), worktrees: createWorktrees({ root }),
    workingDir: startDir, projectContext: ensureProjectContext(startDir),
    loading: true, closed: false, repoChanging: false,
    children: () => children,
  };
  const notes = saved.notes && typeof saved.notes === 'object' ? saved.notes : {};
  const childModelDefaults = saved.childModelDefaults && typeof saved.childModelDefaults === 'object' ? { ...saved.childModelDefaults } : {};

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const data = { cwd: ctx.workingDir, notes, recent: repos.recent, globalPrompt: prompt.state, ...learning.state(), childModelDefaults, repoChats: repos.repoChats,
      agents: [...entries.values()].map((a) => ({ config: a.config, state: a.cli ? a.cli.save() : { events: a.events, effort: a.effort } })) };
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
    for (const a of entries.values()) history.saveConversation(a);
  }
  function schedule() {
    if (ctx.loading || ctx.closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { save(); } catch (e) { console.error('Could not save workspace:', e.message); } }, 500);
  }
  const emit = (msg) => {
    if (ctx.closed) return;
    broadcast(msg); schedule();
    if (msg.t === 'ev') { const a = entries.get(msg.agent); if (a) learning.onAgentEvent(a, msg.ev); else learning.observeEdit(msg.ev); }
    else if (msg.t === 'child-event') learning.observeEdit(msg.ev);
  };
  Object.assign(ctx, { emit, schedule, save, snapshot: () => snapshot() });

  const learning = createLearning(ctx);
  const prompt = createPrompt(ctx, learning);
  ctx.renderPrompt = prompt.render;
  const api = createApiChat(ctx);
  const history = createHistory(ctx); ctx.history = history;
  ctx.add = (config, state) => add(config, state);
  const repos = createRepoSwitcher(ctx);

  /** One CLI wrapper per main agent. The app, not the model, enforces learning mode. */
  function makeCli(a) {
    const { config } = a;
    return createAgents({ cwd: a.cwd, specs, providers: [config.provider], ...getAgentContext(config),
      getInstructions: () => prompt.render(config.name, { provider: config.provider }),
      denyTool: (name) => learning.denyTool(a, name),
      broadcast: (msg) => {
        if (entries.get(config.id) !== a) return;
        emit({ ...msg, agent: config.id });
        learning.onCliMessage(a, msg);
      } });
  }

  function add(input, state) {
    if (entries.size >= 8) throw new Error('Up to eight planets per workspace.');
    const provider = input.provider;
    if (!['claude', 'codex', 'api'].includes(provider)) throw new Error('Choose Claude CLI, Codex CLI or a compatible API.');
    const config = { id: input.id || `${provider}-${crypto.randomBytes(4).toString('hex')}`, provider,
      name: String(input.name || provider).trim().slice(0, 32), model: input.model || null,
      conversationId: input.conversationId || crypto.randomUUID() };
    if (!/^[a-z][a-z0-9-]{0,50}$/.test(config.id) || entries.has(config.id)) throw new Error('Invalid or duplicate agent ID.');
    if (config.model && !validModel(config.model)) throw new Error('Invalid model name.');
    if (provider === 'api') {
      if (!config.model) throw new Error('API planets need a model name.');
      const url = new URL(input.endpoint);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS, or HTTP for a local model server.');
      config.endpoint = url.href;
      config.keyEnv = String(input.keyEnv || '');
      if (config.keyEnv && !/^[A-Z][A-Z0-9_]{0,79}$/.test(config.keyEnv)) throw new Error('Enter an environment variable name, not an API key.');
    }
    const agentCwd = provider === 'api' ? ctx.workingDir : ctx.worktrees.ensure(ctx.workingDir, `agent-${config.id}`);
    const a = { config, cwd: agentCwd, events: state?.events || [], effort: state?.effort || null, controller: null };
    entries.set(config.id, a);
    if (provider !== 'api') {
      a.cli = makeCli(a);
      if (state) a.cli.restore(state);
      if (!state && config.model) a.cli.setModel(provider, config.model);
    }
    schedule();
    return config;
  }

  const defaults = [{ id: 'claude', name: 'Claude', provider: 'claude' }, { id: 'codex', name: 'Codex', provider: 'codex' }];
  for (const row of saved.agents || defaults.map((config) => ({ config }))) {
    try { add(row.config, row.state); } catch (e) { console.error('Could not restore agent:', e.message); }
  }
  if (!entries.size) for (const c of defaults) add(c);
  ctx.loading = false;
  for (const a of entries.values()) learning.relock(a);

  function snapshot() {
    return Object.fromEntries([...entries].map(([id, a]) => [id, a.cli ? a.cli.snapshot()[a.config.provider] : { events: a.events, meta: api.meta(a) }]));
  }

  children = createChildren({ root, specs, getCwd: () => ctx.workingDir, getWorktree: (repo, id) => ctx.worktrees.ensure(repo, id), broadcast: emit, pluginRoots, pollMs: childPollMs,
    getInstructions: (provider) => prompt.render(provider === 'claude' ? 'Claude' : 'Codex', { provider, child: true }),
    getParents: () => [...entries.values()].map((a) => ({ id: a.config.id, key: a.config.conversationId, cwd: a.cwd, provider: a.config.provider,
      sessionId: a.cli?.save()[a.config.provider]?.sessionId })) });

  const learningState = () => ({ learnerProfile: learning.profile, learningMode: learning.enabled, stack: learning.stack(), checkpoints: learning.checkpoints() });

  return {
    get cwd() { return ctx.workingDir; },
    /** Folders the user can push from or open a terminal in: the repository, then each agent's own worktree. */
    workDirs: () => [{ id: 'repo', name: 'Repository', cwd: ctx.workingDir }, ...[...entries.values()].filter((a) => a.cli).map((a) => ({ id: a.config.id, name: a.config.name, cwd: a.cwd }))],
    configs: () => [...entries.values()].map((a) => ({ ...a.config, available: !!snapshot()[a.config.id].meta.available })),
    snapshot, add, remove: repos.remove, switchRepo: repos.switchRepo,
    chatHistory: history.chatHistory, reopenChat: history.reopenChat,
    children: () => children.snapshot(),
    pollChildren: () => children.poll(),
    childAction(m) {
      if (ctx.repoChanging) throw new Error('Wait for the repository clone to finish.');
      if (m.t !== 'child-create') return children.action(m);
      if (m.viaAgent) learning.guardDelegation(entries.get(m.agent));
      const provider = m.provider;
      if (m.model) childModelDefaults[provider] = m.model;
      else if (childModelDefaults[provider]) m = { ...m, model: childModelDefaults[provider] };
      const child = children.create(m.agent, m); save(); return child;
    },
    localState: () => ({ cwd: ctx.workingDir, notes: typeof notes[ctx.workingDir] === 'string' ? notes[ctx.workingDir] : '', recent: repos.recent, prompt: prompt.state, ...learningState(), childModelDefaults }),
    savePrompt(text, on) { const out = prompt.save(text, on); save(); return out; },
    saveLearnerProfile(profile) { learning.saveProfile(profile); save(); return learningState(); },
    setLearningMode(on) { learning.setEnabled(on); save(); return learningState(); },
    journal: () => learning.journal(),
    clearJournal() { learning.clearJournal(); return learning.journal(); },
    saveNotes(cwd, text) {
      if (cwd !== ctx.workingDir) throw new Error('Repository changed. Reopen Notes before saving.');
      if (typeof text !== 'string' || text.length > 30000) throw new Error('Notes can contain up to 30,000 characters.');
      notes[cwd] = text; save();
      return { cwd, notes: text, recent: repos.recent };
    },
    stopAll() {
      children.stopAll();
      for (const a of entries.values()) {
        if (a.cli) a.cli.stop(a.config.provider);
        else if (a.controller) {
          a.controller.abort(); a.controller = null;
          api.put(a, { k: 'note', id: crypto.randomUUID(), text: 'Stopped.' });
          emit({ t: 'meta', agent: a.config.id, meta: api.meta(a) });
        }
      }
      schedule();
    },
    async withRepoChange(work) {
      if (ctx.repoChanging) throw new Error('A repository clone is already running.');
      if (repos.busy()) throw new Error('Stop all running agents before cloning and opening a repository.');
      ctx.repoChanging = true;
      try { return await work((next) => repos.switchRepo(next, true)); }
      finally { ctx.repoChanging = false; }
    },
    action(m) {
      if (ctx.repoChanging && m.t === 'send') throw new Error('Wait for the repository clone to finish before sending a task.');
      const a = entries.get(m.agent);
      if (!a) throw new Error('Unknown agent.');
      if (m.t === 'implement') return learning.implement(a, { skipDesign: m.skipDesign === true });
      if (m.t === 'confirm-design') return learning.confirmDesign(a);
      if (m.t === 'mode') learning.guardMode(a, m.mode);
      if (m.t === 'send') learning.onSend(a, m.text);
      const attachments = m.t === 'send' ? ctx.images.resolve(m.attachments) : [];
      if (m.t === 'send' && !String(m.text || '').trim() && attachments.length) m = { ...m, text: 'Describe these images.' };
      if (m.t === 'newchat') {
        if (ctx.repoChanging) throw new Error('Wait for the repository clone to finish.');
        if (snapshot()[m.agent].meta.busy) throw new Error('Stop this agent before starting a new chat.');
        if (children.snapshot().some((c) => c.parentId === m.agent && c.meta.busy)) throw new Error('Finish or stop this conversation’s child tasks before starting a new chat.');
        history.saveConversation(a);
        a.config.conversationId = crypto.randomUUID();
        learning.reset(a);
        // Refresh the delegation token and instructions for the new conversation.
        if (a.cli) {
          const state = a.cli.save(); a.cli.closeAll();
          a.cli = makeCli(a);
          a.cli.restore(state);
        }
        emit({ t: 'children', children: children.snapshot() });
      }
      if (a.cli) {
        const method = { send: 'send', stop: 'stop', mode: 'setMode', model: 'setModel', effort: 'setEffort', newchat: 'newChat', approve: 'approve' }[m.t];
        if (method) {
          const out = a.cli[method](a.config.provider, m.text ?? m.mode ?? m.model ?? m.effort ?? m.requestId, m.t === 'send' ? attachments : m.allow === true, m.answers);
          if (m.t === 'approve') learning.onApproved(a, out);
        }
      } else {
        if (m.t === 'send') return api.send(a, m.text, attachments);
        if (m.t === 'stop' || m.t === 'newchat') {
          a.controller?.abort(); a.controller = null;
          if (m.t === 'newchat') a.events = [];
          else api.put(a, { k: 'note', id: crypto.randomUUID(), text: 'Stopped.' });
          emit({ t: 'reset', agent: m.agent, events: a.events, meta: api.meta(a) });
        } else if (!a.controller && m.t === 'model' && validModel(m.model)) a.config.model = m.model;
        else if (!a.controller && m.t === 'effort' && [null, '', 'low', 'medium', 'high', 'xhigh'].includes(m.effort)) a.effort = m.effort || null;
        emit({ t: 'meta', agent: m.agent, meta: api.meta(a) });
      }
      schedule();
      if (m.t === 'newchat') save();
    },
    closeAll() { clearTimeout(timer); if (!ctx.closed) { children.close(); try { save(); } catch {} } ctx.closed = true; for (const a of entries.values()) { a.cli?.closeAll(); a.controller?.abort(); } },
  };
}
