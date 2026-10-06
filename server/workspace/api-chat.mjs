// "API planets": chat-only agents backed by a Chat Completions endpoint. They have no file or shell tools.

import crypto from 'node:crypto';
import { apiContent, imageMetadata } from '../images.mjs';

/** `ctx` supplies: workingDir (current), images, fetchImpl, emit, renderPrompt(name). */
export function createApiChat(ctx) {
  function meta(a) {
    return { available: !a.config.keyEnv || !!process.env[a.config.keyEnv], busy: !!a.controller,
      model: a.config.model, modelPref: a.config.model, effort: a.effort || null,
      mode: 'read', turns: a.events.filter((e) => e.k === 'turn' && e.ok).length, session: a.events.length > 0,
      capability: 'API chat · no local file tools', awaiting: 0 };
  }

  function put(a, ev) { a.events.push(ev); ctx.emit({ t: 'ev', agent: a.config.id, ev }); }

  async function send(a, text, attachments = []) {
    if (a.controller) throw new Error('Stop the current turn first.');
    if (!meta(a).available) throw new Error(`Set ${a.config.keyEnv} in the server environment and restart Tandem.`);
    const controller = a.controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 180000);
    const id = crypto.randomUUID();
    put(a, { k: 'user', id: `${id}:u`, text, attachments: imageMetadata(attachments), at: Date.now() });
    ctx.emit({ t: 'meta', agent: a.config.id, meta: meta(a) });
    try {
      const standing = ctx.renderPrompt(a.config.name);
      const messages = [{ role: 'system', content: `You are a chat assistant in Tandem. Working repository: ${ctx.workingDir}. You have no file or shell tools. Ask the user to provide code when needed. Never claim to have read or changed local files.${standing ? `\n\nStanding instructions from the user:\n${standing}` : ''}` }, ...a.events.filter((e) => e.k === 'user' || (e.k === 'msg' && e.done)).map((e) => ({ role: e.k === 'user' ? 'user' : 'assistant', content: e.k === 'user' ? apiContent(e.text, ctx.images.resolve(e.attachments)) : e.text }))];
      const res = await ctx.fetchImpl(a.config.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
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
      if (a.controller === controller) { a.controller = null; ctx.emit({ t: 'meta', agent: a.config.id, meta: meta(a) }); }
    }
  }

  return { meta, put, send };
}
