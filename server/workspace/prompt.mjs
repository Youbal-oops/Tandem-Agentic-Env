// The standing instructions every agent receives: the user's global prompt, the project context, and
// (for main agents in learning mode) the learner profile, working method and journal.

import path from 'node:path';

const MAX_PROMPT = 8000;

/** `ctx` supplies: saved, workingDir, projectContext (both current). `learning` is the learning-mode controller. */
export function createPrompt(ctx, learning) {
  let globalPrompt = { text: typeof ctx.saved.globalPrompt?.text === 'string' ? ctx.saved.globalPrompt.text.slice(0, MAX_PROMPT) : '', on: ctx.saved.globalPrompt?.on !== false };

  // Rendered fresh on every send, so a repo switch or a new chat always picks up the current repo.
  // Subagent chats get the standing prompt and project context only; the learner profile and working method are for main agents.
  function render(name, { provider = 'codex', child = false } = {}) {
    const prompt = !globalPrompt.on ? '' : globalPrompt.text.trim().replaceAll('{{repo}}', path.basename(ctx.workingDir)).replaceAll('{{path}}', ctx.workingDir).replaceAll('{{agent}}', name);
    const context = ctx.projectContext.text && `[Shared project context: ${ctx.projectContext.file}]\n${ctx.projectContext.text}`;
    return [prompt, context, ...(child ? [] : learning.promptBlocks(provider))].filter(Boolean).join('\n\n');
  }

  return {
    render,
    get state() { return globalPrompt; },
    save(text, on) {
      if (typeof text !== 'string' || text.length > MAX_PROMPT) throw new Error(`The prompt can contain up to ${MAX_PROMPT.toLocaleString()} characters.`);
      globalPrompt = { text, on: on !== false };
      return { prompt: globalPrompt };
    },
  };
}
