// The standing instructions every agent receives: the user's global prompt, the project context, and
// (for main agents in learning mode) the learner profile, working method and journal.

import fs from 'node:fs';
import path from 'node:path';

/** The folder every agent of a project can read and write, outside each agent's own copy of the project. */
export const sharedDirOf = (repo) => path.join(repo, '.tandem', 'shared');

const MAX_PROMPT = 8000;

/** `ctx` supplies: saved, workingDir, projectContext (both current). `learning` is the learning-mode controller. */
export function createPrompt(ctx, learning, extraBlocks = () => []) {
  let globalPrompt = { text: typeof ctx.saved.globalPrompt?.text === 'string' ? ctx.saved.globalPrompt.text.slice(0, MAX_PROMPT) : '', on: ctx.saved.globalPrompt?.on !== false };

  // Rendered fresh on every send, so a repo switch or a new chat always picks up the current repo.
  // Subagent chats get the standing prompt and project context only; the learner profile and working method are for main agents.
  function render(name, { provider = 'codex', child = false } = {}) {
    const prompt = !globalPrompt.on ? '' : globalPrompt.text.trim().replaceAll('{{repo}}', path.basename(ctx.workingDir)).replaceAll('{{path}}', ctx.workingDir).replaceAll('{{agent}}', name);
    const context = ctx.projectContext.text && `[Shared project context: ${ctx.projectContext.file}]\n${ctx.projectContext.text}`;
    const shared = sharedDirOf(ctx.workingDir);
    try { fs.mkdirSync(shared, { recursive: true }); } catch { /* the note below is still true if it can be made later */ }
    const team = `[Shared team folder: ${shared}]\nEach agent works in its own copy of the project, so it cannot see the files you create in yours, and you cannot see theirs. This folder is shared by every agent and by the user. When something is meant for other agents or the user to see (a plan, spec, notes, a task list, a decision, a hand-off), write it as a document in this folder, and look here for what others have left. Keep it to documents: code changes belong in your own folder and go through review.`;
    return [prompt, context, team, ...(child ? [] : [...extraBlocks(provider), ...learning.promptBlocks(provider)])].filter(Boolean).join('\n\n');
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
