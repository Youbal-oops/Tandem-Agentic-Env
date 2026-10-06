// Saved conversations: every chat is written to .tandem/conversations so it can be reopened from "history".

import fs from 'node:fs';
import path from 'node:path';

const validConversationId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);

/** `ctx` supplies: dir, entries, workingDir (current), repoChanging (current), snapshot(), children, add(), save(). */
export function createHistory(ctx) {
  const historyDir = path.join(ctx.dir, 'conversations');
  const conversationState = (a) => a.cli ? a.cli.save() : { events: a.events, effort: a.effort };

  function saveConversation(a) {
    if (!validConversationId(a.config.conversationId)) return;
    fs.mkdirSync(historyDir, { recursive: true });
    const target = path.join(historyDir, `${a.config.conversationId}.json`);
    fs.writeFileSync(target + '.tmp', JSON.stringify({ cwd: ctx.workingDir, config: { ...a.config }, state: conversationState(a), updatedAt: Date.now() }));
    fs.renameSync(target + '.tmp', target);
  }

  function readConversation(id) {
    if (!validConversationId(id)) throw new Error('Invalid conversation ID.');
    try { return JSON.parse(fs.readFileSync(path.join(historyDir, `${id}.json`), 'utf8')); }
    catch { throw new Error('That conversation could not be loaded.'); }
  }

  function chatHistory(agent) {
    const a = ctx.entries.get(agent);
    if (!a) throw new Error('Unknown agent.');
    const rows = [];
    for (const filename of fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : []) {
      if (!filename.endsWith('.json')) continue;
      try {
        const row = readConversation(filename.slice(0, -5));
        if (row.cwd === ctx.workingDir && row.config.id === agent && row.config.provider === a.config.provider && row.config.conversationId !== a.config.conversationId) rows.push(row);
      } catch { /* Leave damaged records intact, but omit them from the picker. */ }
    }
    rows.push({ cwd: ctx.workingDir, config: a.config, state: conversationState(a), updatedAt: Date.now() });
    return rows.map((row) => {
      const events = row.config.provider === 'api' ? row.state.events : row.state[row.config.provider]?.events;
      const messages = (events || []).filter((event) => event.k === 'user');
      return { id: row.config.conversationId, title: String(messages[0]?.text || 'New conversation').replace(/\s+/g, ' ').slice(0, 120), updatedAt: row.updatedAt, messages: messages.length, active: row.config.conversationId === a.config.conversationId };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function reopenChat(agent, id, cwd) {
    if (ctx.repoChanging) throw new Error('Wait for the repository clone to finish.');
    if (cwd !== ctx.workingDir) throw new Error('Repository changed. Reopen chat history.');
    const a = ctx.entries.get(agent);
    if (!a) throw new Error('Unknown agent.');
    if (ctx.snapshot()[agent].meta.busy || ctx.children().snapshot().some((c) => c.parentId === agent && c.meta.busy)) throw new Error('Stop this agent and its child tasks before switching conversations.');
    if (id === a.config.conversationId) return;
    const row = readConversation(id);
    if (row.cwd !== ctx.workingDir || row.config.id !== agent || row.config.provider !== a.config.provider) throw new Error('That conversation belongs to a different project or agent.');
    saveConversation(a);
    a.cli?.closeAll();
    ctx.entries.delete(agent);
    ctx.add(row.config, row.state);
    ctx.save();
  }

  return { saveConversation, chatHistory, reopenChat };
}
