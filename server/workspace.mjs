import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAgents, validModel } from './agents.mjs';
import { createChildren } from './children.mjs';
import { createImageStore, imageMetadata, apiContent } from './images.mjs';
import { createWorktrees } from './worktrees.mjs';
import { ensureProjectContext } from './project-context.mjs';

const MAX_PROMPT = 8000;

// One CLI adapter per planet, so two Codex/Claude planets never share a thread.
export function createWorkspace({ root, cwd, specs, broadcast, fetchImpl = fetch, getAgentContext = () => ({}), pluginRoots, childPollMs }) {
  const dir = path.join(root, '.tandem');
  const images = createImageStore(root);
  const worktrees = createWorktrees({ root });
  const file = path.join(dir, 'workspace.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let workingDir = fs.existsSync(saved.cwd || '') ? saved.cwd : cwd;
  let projectContext = ensureProjectContext(workingDir);
  const entries = new Map();
  let children;
  let timer;
  let loading = true;
  let closed = false;
  let repoChanging = false;
  let globalPrompt = { text: typeof saved.globalPrompt?.text === 'string' ? saved.globalPrompt.text.slice(0, MAX_PROMPT) : '', on: saved.globalPrompt?.on !== false };
  let learnerProfile = {
    familiar: String(saved.learnerProfile?.familiar || '').slice(0, 2000),
    learning: String(saved.learnerProfile?.learning || '').slice(0, 2000),
    observed: Array.isArray(saved.learnerProfile?.observed) ? saved.learnerProfile.observed.filter((x) => typeof x === 'string').slice(0, 40) : [],
    level: ['new', 'familiar', 'confident'].includes(saved.learnerProfile?.level) ? saved.learnerProfile.level : 'familiar',
    style: ['plain', 'examples', 'diagrams', 'questions'].includes(saved.learnerProfile?.style) ? saved.learnerProfile.style : 'plain',
    checkpoints: ['light', 'normal', 'frequent'].includes(saved.learnerProfile?.checkpoints) ? saved.learnerProfile.checkpoints : 'normal',
  };
  const childModelDefaults = saved.childModelDefaults && typeof saved.childModelDefaults === 'object' ? { ...saved.childModelDefaults } : {};
  // Rendered fresh on every send, so a repo switch or a new chat always picks up the current repo.
  const renderPrompt = (name) => {
    const prompt = !globalPrompt.on ? '' : globalPrompt.text.trim().replaceAll('{{repo}}', path.basename(workingDir)).replaceAll('{{path}}', workingDir).replaceAll('{{agent}}', name);
    const profile = [learnerProfile.familiar && `Familiar stack: ${learnerProfile.familiar}`, learnerProfile.learning && `Learning goals: ${learnerProfile.learning}`, learnerProfile.observed.length && `Observed in their work: ${learnerProfile.observed.join(', ')}`, `Experience: ${learnerProfile.level}; teaching preference: ${learnerProfile.style}; checkpoint frequency: ${learnerProfile.checkpoints}.`, 'For material design choices, show viable options with complexity and tradeoffs. Recommend, but let the user choose before implementing.'].filter(Boolean).join('\n');
    return [prompt, projectContext.text && `[Shared project context: ${projectContext.file}]\n${projectContext.text}`, profile && `[Learner profile]\n${profile}`].filter(Boolean).join('\n\n');
  };
  // Chats of every repository other than the open one, keyed by its real path, so switching back (or
  // restarting tomorrow) finds them where they were. The open repo's chats live in `entries`.
  const repoChats = saved.repoChats && typeof saved.repoChats === 'object' && !Array.isArray(saved.repoChats) ? saved.repoChats : {};
  const notes = saved.notes && typeof saved.notes === 'object' ? saved.notes : {};
  let recent = Array.isArray(saved.recent) ? saved.recent.filter((p) => typeof p === 'string').slice(0, 12) : [];
  const remember = () => { recent = [workingDir, ...recent.filter((p) => p !== workingDir)].slice(0, 12); };
  remember();
  const historyDir = path.join(dir, 'conversations');
  const validConversationId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
  const conversationState = (a) => a.cli ? a.cli.save() : { events: a.events, effort: a.effort };
  function saveConversation(a) {
    if (!validConversationId(a.config.conversationId)) return;
    fs.mkdirSync(historyDir, { recursive: true });
    const target = path.join(historyDir, `${a.config.conversationId}.json`);
    fs.writeFileSync(target + '.tmp', JSON.stringify({ cwd: workingDir, config: { ...a.config }, state: conversationState(a), updatedAt: Date.now() }));
    fs.renameSync(target + '.tmp', target);
  }
  function readConversation(id) {
    if (!validConversationId(id)) throw new Error('Invalid conversation ID.');
    try { return JSON.parse(fs.readFileSync(path.join(historyDir, `${id}.json`), 'utf8')); }
    catch { throw new Error('That conversation could not be loaded.'); }
  }
  function chatHistory(agent) {
    const a = entries.get(agent);
    if (!a) throw new Error('Unknown agent.');
    const rows = [];
    for (const filename of fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : []) {
      if (!filename.endsWith('.json')) continue;
      try {
        const row = readConversation(filename.slice(0, -5));
        if (row.cwd === workingDir && row.config.id === agent && row.config.provider === a.config.provider && row.config.conversationId !== a.config.conversationId) rows.push(row);
      } catch { /* Leave damaged records intact, but omit them from the picker. */ }
    }
    rows.push({ cwd: workingDir, config: a.config, state: conversationState(a), updatedAt: Date.now() });
    return rows.map((row) => {
      const events = row.config.provider === 'api' ? row.state.events : row.state[row.config.provider]?.events;
      const messages = (events || []).filter((event) => event.k === 'user');
      return { id: row.config.conversationId, title: String(messages[0]?.text || 'New conversation').replace(/\s+/g, ' ').slice(0, 120), updatedAt: row.updatedAt, messages: messages.length, active: row.config.conversationId === a.config.conversationId };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function reopenChat(agent, id, cwd) {
    if (repoChanging) throw new Error('Wait for the repository clone to finish.');
    if (cwd !== workingDir) throw new Error('Repository changed. Reopen chat history.');
    const a = entries.get(agent);
    if (!a) throw new Error('Unknown agent.');
    if (snapshot()[agent].meta.busy || children.snapshot().some((c) => c.parentId === agent && c.meta.busy)) throw new Error('Stop this agent and its child tasks before switching conversations.');
    if (id === a.config.conversationId) return;
    const row = readConversation(id);
    if (row.cwd !== workingDir || row.config.id !== agent || row.config.provider !== a.config.provider) throw new Error('That conversation belongs to a different project or agent.');
    saveConversation(a);
    a.cli?.closeAll();
    entries.delete(agent);
    add(row.config, row.state);
    save();
  }
  function save() {
    fs.mkdirSync(dir, { recursive: true });
    const data = { cwd: workingDir, notes, recent, globalPrompt, learnerProfile, childModelDefaults, repoChats, agents: [...entries.values()].map((a) => ({ config: a.config, state: a.cli ? a.cli.save() : { events: a.events, effort: a.effort } })) };
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
    for (const a of entries.values()) saveConversation(a);
  }
  function schedule() {
    if (loading || closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { try { save(); } catch (e) { console.error('Could not save workspace:', e.message); } }, 500);
  }
  const emit = (msg) => { if (closed) return; broadcast(msg); schedule(); };
  function observeLearning(text) {
    const matches = String(text || '').toLowerCase().match(/\b(javascript|typescript|react|next\.js|node\.js|python|java|sql|postgres(?:ql)?|supabase|docker|git|testing|css|html|api|authentication|security)\b/g) || [];
    const found = [...new Set(matches.map((x) => x === 'postgresql' ? 'Postgres' : x === 'next.js' ? 'Next.js' : x === 'node.js' ? 'Node.js' : x.toUpperCase() === x ? x : x[0].toUpperCase() + x.slice(1)))];
    const add = found.filter((x) => !learnerProfile.observed.includes(x));
    if (!add.length) return;
    learnerProfile.observed = [...learnerProfile.observed, ...add].slice(-40);
    emit({ t: 'learnerprofile', learnerProfile });
  }
  function apiMeta(a) {
    return { available: !a.config.keyEnv || !!process.env[a.config.keyEnv], busy: !!a.controller,
      model: a.config.model, modelPref: a.config.model, effort: a.effort || null,
      mode: 'read', turns: a.events.filter((e) => e.k === 'turn' && e.ok).length, session: a.events.length > 0,
      capability: 'API chat · no local file tools', awaiting: 0 };
  }
  function put(a, ev) { a.events.push(ev); emit({ t: 'ev', agent: a.config.id, ev }); }
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
    const agentCwd = provider === 'api' ? workingDir : worktrees.ensure(workingDir, `agent-${config.id}`);
    const a = { config, cwd: agentCwd, events: state?.events || [], effort: state?.effort || null, controller: null };
    entries.set(config.id, a);
    if (provider !== 'api') {
      a.cli = createAgents({ cwd: a.cwd, specs, providers: [provider], ...getAgentContext(config), getInstructions: () => renderPrompt(config.name), broadcast: (msg) => {
        if (entries.get(config.id) !== a) return;
        emit({ ...msg, agent: config.id });
      } });
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
  loading = false;
  function snapshot() {
    return Object.fromEntries([...entries].map(([id, a]) => [id, a.cli ? a.cli.snapshot()[a.config.provider] : { events: a.events, meta: apiMeta(a) }]));
  }
  async function sendApi(a, text, attachments = []) {
    if (a.controller) throw new Error('Stop the current turn first.');
    if (!apiMeta(a).available) throw new Error(`Set ${a.config.keyEnv} in the server environment and restart Tandem.`);
    const controller = a.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 180000);
    const id = crypto.randomUUID();
    put(a, { k: 'user', id: `${id}:u`, text, attachments: imageMetadata(attachments), at: Date.now() });
    emit({ t: 'meta', agent: a.config.id, meta: apiMeta(a) });
    try {
      const messages = [{ role: 'system', content: `You are a chat assistant in Tandem. Working repository: ${workingDir}. You have no file or shell tools. Ask the user to provide code when needed. Never claim to have read or changed local files.${renderPrompt(a.config.name) ? `\n\nStanding instructions from the user:\n${renderPrompt(a.config.name)}` : ''}` }, ...a.events.filter((e) => e.k === 'user' || (e.k === 'msg' && e.done)).map((e) => ({ role: e.k === 'user' ? 'user' : 'assistant', content: e.k === 'user' ? apiContent(e.text, images.resolve(e.attachments)) : e.text }))];
      const res = await fetchImpl(a.config.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(a.config.keyEnv ? { Authorization: `Bearer ${process.env[a.config.keyEnv]}` } : {}) },
        body: JSON.stringify({ model: a.config.model, messages, ...(a.effort ? { reasoning_effort: a.effort } : {}) }) });
      if (!res.ok) throw new Error(`API returned HTTP ${res.status}. Check endpoint, model, key and supported effort.`);
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content;
      if (typeof reply !== 'string') throw new Error('The endpoint did not return a Chat Completions text response.');
      if (a.controller !== controller) return;
      put(a, { k: 'msg', id: `${id}:m`, text: reply, done: true });
      put(a, { k: 'turn', id: `${id}:t`, ok: true, tokens: { in: data.usage?.prompt_tokens, out: data.usage?.completion_tokens } });
    } catch (e) {
      if (a.controller !== controller) return;
      put(a, { k: 'error', id: `${id}:e`, text: controller.signal.aborted ? 'API request stopped or timed out.' : e.message });
      put(a, { k: 'turn', id: `${id}:t`, ok: false });
    } finally {
      clearTimeout(deadline);
      if (a.controller === controller) { a.controller = null; emit({ t: 'meta', agent: a.config.id, meta: apiMeta(a) }); }
    }
  }
  children = createChildren({ root, specs, getCwd: () => workingDir, getWorktree: (repo, id) => worktrees.ensure(repo, id), broadcast: emit, pluginRoots, pollMs: childPollMs, getInstructions: (provider) => renderPrompt(provider === 'claude' ? 'Claude' : 'Codex'),
    getParents: () => [...entries.values()].map((a) => ({ id: a.config.id, key: a.config.conversationId, cwd: a.cwd, provider: a.config.provider,
      sessionId: a.cli?.save()[a.config.provider]?.sessionId })) });
  const busy = () => Object.values(snapshot()).some((s) => s.meta.busy) || children.busy();
  function remove(id) {
    const a = entries.get(id);
    if (!a) return;
    if (entries.size === 1) throw new Error('Keep at least one planet.');
    if (snapshot()[id].meta.busy || children.snapshot().some((c) => c.parentId === id && c.meta.busy)) throw new Error('Stop this agent and its child tasks before removing it.');
    fs.mkdirSync(path.join(dir, 'archives'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archives', `${Date.now()}-${id}.json`), JSON.stringify({ cwd: workingDir, config: a.config, conversation: snapshot()[id] }));
    saveConversation(a);
    entries.delete(id); a.cli?.closeAll(); a.controller?.abort(); schedule();
  }
  function switchRepo(next, reserved = false) {
    if (repoChanging && !reserved) throw new Error('Wait for the repository clone to finish.');
    if (busy()) throw new Error('Stop all running agents before changing repositories.');
    if (typeof next !== 'string' || !path.isAbsolute(next)) throw new Error('Enter the full local folder path.');
    next = fs.realpathSync(next);
    if (!fs.statSync(next).isDirectory()) throw new Error('That path is not a folder.');
    if (next === workingDir) return;
    // Archive old chats before resetting their repo-bound CLI sessions.
    fs.mkdirSync(path.join(dir, 'archives'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'archives', `${Date.now()}.json`), JSON.stringify({ cwd: workingDir, agents: snapshot() }));
    for (const a of entries.values()) saveConversation(a);
    const configs = [...entries.values()].map((a) => ({ config: { ...a.config }, settings: a.cli ? a.cli.save() : { effort: a.effort } }));
    // Keep this repo's chats (full state, same session ids) for when it is opened again.
    repoChats[workingDir] = [...entries.values()].map((a) => ({ config: { ...a.config }, state: a.cli ? a.cli.save() : { events: a.events, effort: a.effort } }));
    for (const a of entries.values()) a.cli?.closeAll();
    entries.clear(); workingDir = next; projectContext = ensureProjectContext(workingDir);
    remember();
    const returning = repoChats[next];
    delete repoChats[next];
    if (Array.isArray(returning) && returning.length) {
      for (const row of returning) {
        try { add(row.config, row.state); } catch (e) { console.error('Could not restore agent:', e.message); }
      }
    }
    if (!entries.size) for (const { config, settings } of configs) {
      config.conversationId = crypto.randomUUID();
      if (config.provider === 'api') add(config, { events: [], effort: settings.effort });
      else add(config, { [config.provider]: { ...settings[config.provider], events: [], sessionId: null, turns: 0, cost: 0, seq: 0 } });
    }
    save();
  }
  return {
    get cwd() { return workingDir; },
    configs: () => [...entries.values()].map((a) => ({ ...a.config, available: !!snapshot()[a.config.id].meta.available })),
    snapshot, add, remove, switchRepo, chatHistory, reopenChat,
    children: () => children.snapshot(),
    pollChildren: () => children.poll(),
    childAction(m) {
      if (repoChanging) throw new Error('Wait for the repository clone to finish.');
      if (m.t !== 'child-create') return children.action(m);
      const provider = m.provider;
      if (m.model) childModelDefaults[provider] = m.model;
      else if (childModelDefaults[provider]) m = { ...m, model: childModelDefaults[provider] };
      const child = children.create(m.agent, m); save(); return child;
    },
    localState: () => ({ cwd: workingDir, notes: typeof notes[workingDir] === 'string' ? notes[workingDir] : '', recent, prompt: globalPrompt, learnerProfile, childModelDefaults }),
    savePrompt(text, on) {
      if (typeof text !== 'string' || text.length > MAX_PROMPT) throw new Error(`The prompt can contain up to ${MAX_PROMPT.toLocaleString()} characters.`);
      globalPrompt = { text, on: on !== false }; save();
      return { prompt: globalPrompt };
    },
    saveLearnerProfile(profile) {
      if (!profile || typeof profile !== 'object') throw new Error('Invalid learner profile.');
      learnerProfile = {
        familiar: String(profile.familiar || '').slice(0, 2000), learning: String(profile.learning || '').slice(0, 2000),
        observed: Array.isArray(profile.observed) ? profile.observed.filter((x) => typeof x === 'string').slice(0, 40) : learnerProfile.observed,
        level: ['new', 'familiar', 'confident'].includes(profile.level) ? profile.level : 'familiar', style: ['plain', 'examples', 'diagrams', 'questions'].includes(profile.style) ? profile.style : 'plain', checkpoints: ['light', 'normal', 'frequent'].includes(profile.checkpoints) ? profile.checkpoints : 'normal',
      };
      save(); return { learnerProfile };
    },
    saveNotes(cwd, text) {
      if (cwd !== workingDir) throw new Error('Repository changed. Reopen Notes before saving.');
      if (typeof text !== 'string' || text.length > 30000) throw new Error('Notes can contain up to 30,000 characters.');
      notes[cwd] = text; save();
      return { cwd, notes: text, recent };
    },
    stopAll() {
      children.stopAll();
      for (const a of entries.values()) {
        if (a.cli) a.cli.stop(a.config.provider);
        else if (a.controller) {
          a.controller.abort(); a.controller = null;
          put(a, { k: 'note', id: crypto.randomUUID(), text: 'Stopped.' });
          emit({ t: 'meta', agent: a.config.id, meta: apiMeta(a) });
        }
      }
      schedule();
    },
    async withRepoChange(work) {
      if (repoChanging) throw new Error('A repository clone is already running.');
      if (busy()) throw new Error('Stop all running agents before cloning and opening a repository.');
      repoChanging = true;
      try { return await work((next) => switchRepo(next, true)); }
      finally { repoChanging = false; }
    },
    action(m) {
      if (repoChanging && m.t === 'send') throw new Error('Wait for the repository clone to finish before sending a task.');
      const a = entries.get(m.agent);
      if (!a) throw new Error('Unknown agent.');
      if (m.t === 'send') observeLearning(m.text);
      const attachments = m.t === 'send' ? images.resolve(m.attachments) : [];
      if (m.t === 'send' && !String(m.text || '').trim() && attachments.length) m = { ...m, text: 'Describe these images.' };
      if (m.t === 'newchat') {
        if (repoChanging) throw new Error('Wait for the repository clone to finish.');
        if (snapshot()[m.agent].meta.busy) throw new Error('Stop this agent before starting a new chat.');
        if (children.snapshot().some((c) => c.parentId === m.agent && c.meta.busy)) throw new Error('Finish or stop this conversation’s child tasks before starting a new chat.');
        saveConversation(a);
        a.config.conversationId = crypto.randomUUID();
        // Refresh the delegation token and instructions for the new conversation.
        if (a.cli) {
          const saved = a.cli.save(); a.cli.closeAll();
          a.cli = createAgents({ cwd: a.cwd, specs, providers: [a.config.provider], ...getAgentContext(a.config), getInstructions: () => renderPrompt(a.config.name), broadcast: (msg) => emit({ ...msg, agent: a.config.id }) });
          a.cli.restore(saved);
        }
        emit({ t: 'children', children: children.snapshot() });
      }
      if (a.cli) {
        const method = { send: 'send', stop: 'stop', mode: 'setMode', model: 'setModel', effort: 'setEffort', newchat: 'newChat', approve: 'approve' }[m.t];
        if (method) a.cli[method](a.config.provider, m.text ?? m.mode ?? m.model ?? m.effort ?? m.requestId, m.t === 'send' ? attachments : m.allow === true);
      } else {
        if (m.t === 'send') return sendApi(a, m.text, attachments);
        if (m.t === 'stop' || m.t === 'newchat') {
          a.controller?.abort(); a.controller = null;
          if (m.t === 'newchat') a.events = [];
          else put(a, { k: 'note', id: crypto.randomUUID(), text: 'Stopped.' });
          emit({ t: 'reset', agent: m.agent, events: a.events, meta: apiMeta(a) });
        } else if (!a.controller && m.t === 'model' && validModel(m.model)) a.config.model = m.model;
        else if (!a.controller && m.t === 'effort' && [null, '', 'low', 'medium', 'high', 'xhigh'].includes(m.effort)) a.effort = m.effort || null;
        emit({ t: 'meta', agent: m.agent, meta: apiMeta(a) });
      }
      schedule();
      if (m.t === 'newchat') save();
    },
    closeAll() { clearTimeout(timer); if (!closed) { children.close(); try { save(); } catch {} } closed = true; for (const a of entries.values()) { a.cli?.closeAll(); a.controller?.abort(); } },
  };
}
