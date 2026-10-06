// Moving between repositories and removing planets. Each repository keeps its own chats, so switching
// away and back (or restarting tomorrow) finds them where they were.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureProjectContext } from '../project-context.mjs';

/** `ctx` supplies: dir, entries, saved, workingDir/projectContext/repoChanging (current), snapshot(), children, add(), save(), schedule(), history. */
export function createRepoSwitcher(ctx) {
  // Chats of every repository other than the open one, keyed by its real path. The open repo's chats live in `entries`.
  const repoChats = ctx.saved.repoChats && typeof ctx.saved.repoChats === 'object' && !Array.isArray(ctx.saved.repoChats) ? ctx.saved.repoChats : {};
  let recent = Array.isArray(ctx.saved.recent) ? ctx.saved.recent.filter((p) => typeof p === 'string').slice(0, 12) : [];
  const remember = () => { recent = [ctx.workingDir, ...recent.filter((p) => p !== ctx.workingDir)].slice(0, 12); };
  remember();

  const busy = () => Object.values(ctx.snapshot()).some((s) => s.meta.busy) || ctx.children().busy();
  const archives = () => { fs.mkdirSync(path.join(ctx.dir, 'archives'), { recursive: true }); return path.join(ctx.dir, 'archives'); };

  function remove(id) {
    const a = ctx.entries.get(id);
    if (!a) return;
    if (ctx.entries.size === 1) throw new Error('Keep at least one planet.');
    if (ctx.snapshot()[id].meta.busy || ctx.children().snapshot().some((c) => c.parentId === id && c.meta.busy)) throw new Error('Stop this agent and its child tasks before removing it.');
    fs.writeFileSync(path.join(archives(), `${Date.now()}-${id}.json`), JSON.stringify({ cwd: ctx.workingDir, config: a.config, conversation: ctx.snapshot()[id] }));
    ctx.history.saveConversation(a);
    ctx.entries.delete(id); a.cli?.closeAll(); a.controller?.abort(); ctx.schedule();
  }

  const stateOf = (a) => (a.cli ? a.cli.save() : { events: a.events, effort: a.effort });

  function switchRepo(next, reserved = false) {
    if (ctx.repoChanging && !reserved) throw new Error('Wait for the repository clone to finish.');
    if (busy()) throw new Error('Stop all running agents before changing repositories.');
    if (typeof next !== 'string' || !path.isAbsolute(next)) throw new Error('Enter the full local folder path.');
    next = fs.realpathSync(next);
    if (!fs.statSync(next).isDirectory()) throw new Error('That path is not a folder.');
    if (next === ctx.workingDir) return;
    // Archive old chats before resetting their repo-bound CLI sessions.
    fs.writeFileSync(path.join(archives(), `${Date.now()}.json`), JSON.stringify({ cwd: ctx.workingDir, agents: ctx.snapshot() }));
    for (const a of ctx.entries.values()) ctx.history.saveConversation(a);
    const configs = [...ctx.entries.values()].map((a) => ({ config: { ...a.config }, settings: a.cli ? a.cli.save() : { effort: a.effort } }));
    // Keep this repo's chats (full state, same session ids) for when it is opened again.
    repoChats[ctx.workingDir] = [...ctx.entries.values()].map((a) => ({ config: { ...a.config }, state: stateOf(a) }));
    for (const a of ctx.entries.values()) a.cli?.closeAll();
    ctx.entries.clear(); ctx.workingDir = next; ctx.projectContext = ensureProjectContext(ctx.workingDir);
    remember();
    const returning = repoChats[next];
    delete repoChats[next];
    if (Array.isArray(returning) && returning.length) {
      for (const row of returning) {
        try { ctx.add(row.config, row.state); } catch (e) { console.error('Could not restore agent:', e.message); }
      }
    }
    if (!ctx.entries.size) for (const { config, settings } of configs) {
      config.conversationId = crypto.randomUUID();
      if (config.provider === 'api') ctx.add(config, { events: [], effort: settings.effort });
      else ctx.add(config, { [config.provider]: { ...settings[config.provider], events: [], sessionId: null, turns: 0, cost: 0, seq: 0 } });
    }
    ctx.save();
  }

  return { repoChats, get recent() { return recent; }, busy, remove, switchRepo };
}
