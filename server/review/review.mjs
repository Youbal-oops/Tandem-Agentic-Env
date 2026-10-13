// Review batches: what an agent has changed since the user last approved, the size budget it is asked to
// plan within, a hard cutoff just above that budget, and the user's edits and questions about it.
//
// A batch starts as a git tree snapshot of the agent's folder. After each finished edit the folder is
// snapshotted again and compared, so the count is the same for Claude and Codex and covers new files.
//   budget   told to the agent: split big requests into components and stop after each. A job that still ends
//            over it holds that agent's next task until the user has approved.
//   cutoff   a margin above the budget (25% by default). Crossing it stops the agent mid-job: Claude's edit is
//            refused before it is written when the CLI asks first; otherwise it is stopped right after the edit.
// The master switch turns all of it off, for unattended runs.

import { numstat, patch, snapshotTree } from './tree.mjs';

export const PROPOSAL_ROOM = 100; // extra lines a held agent may use to apply the user's edit
const SNIPPET = 4000;

/** The cutoff: the budget plus the margin. At least one extra file, so a small file limit still has some room. */
export function cutoffOf(limits) {
  const pct = limits.margin ?? 25;
  return { enabled: limits.enabled && limits.hardStop !== false, maxLines: Math.ceil(limits.maxLines * (1 + pct / 100)), maxFiles: limits.maxFiles + Math.max(1, Math.ceil(limits.maxFiles * pct / 100)) };
}
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const MAX_CHANGES = 200;

const lines = (s) => (typeof s === 'string' && s ? s.split('\n').length : 0);
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/** Lines an edit tool call would add and remove, from its input alone. */
export function countEdit(name, input = {}) {
  const file = input.file_path || input.notebook_path || '';
  if (name === 'Edit') return { file, added: lines(input.new_string), removed: lines(input.old_string), old: input.old_string, new: input.new_string };
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return { file, added: edits.reduce((n, e) => n + lines(e?.new_string), 0), removed: edits.reduce((n, e) => n + lines(e?.old_string), 0),
      old: edits.map((e) => e?.old_string || '').join('\n…\n'), new: edits.map((e) => e?.new_string || '').join('\n…\n') };
  }
  if (name === 'Write') return { file, added: lines(input.content), removed: 0, new: input.content };
  if (name === 'NotebookEdit') return { file, added: lines(input.new_source), removed: 0, new: input.new_source };
  return null;
}

/** The first limit a batch breaks, as a sentence, or null. */
export function overLimit(stats, limits, extra = 0, room = 0) {
  if (!limits.enabled) return null;
  const maxLines = Math.max(limits.maxLines, room);
  const total = stats.lines + extra;
  if (total > maxLines) return `${total} changed lines is over the limit of ${maxLines}`;
  if (stats.files > limits.maxFiles) return `${stats.files} files is over the limit of ${limits.maxFiles}`;
  return null;
}

/** `ctx` supplies: limits() (current settings), emit(msg), agent(id) (the workspace entry). */
export function createReview({ limits, emit, agent }) {
  const states = new Map();
  const lastText = new Map(); // the agent's most recent finished message: it becomes the note on its next edit

  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { base: null, baseP: null, cur: null, stats: { lines: 0, files: 0, list: [] }, changes: [], held: false, reason: '', room: 0, measuring: Promise.resolve() });
    return states.get(id);
  };

  function view(id) {
    const s = stateOf(id);
    const l = limits();
    return {
      agent: id, limits: l, held: s.held, reason: s.reason, available: s.base !== null || s.baseP !== null,
      lines: s.stats.lines, files: s.stats.files, list: s.stats.list, room: s.room,
      changes: s.changes.map(({ id: cid, file, note, added, removed, old, new: next, status, at }) => ({ id: cid, file, note, added, removed, old, new: next, status, at })),
    };
  }
  const announce = (id) => emit({ t: 'review', review: view(id) });

  /** Take the starting snapshot for this agent's folder. Cheap to call again. */
  function begin(a) {
    const s = stateOf(a.config.id);
    if (!s.baseP) s.baseP = snapshotTree(a.cwd).then((t) => { s.base = t; return t; });
    return s.baseP;
  }

  async function measure(a) {
    const id = a.config.id;
    const s = stateOf(id);
    s.measuring = s.measuring.then(async () => {
      const base = await begin(a);
      if (!base) return;
      const cur = await snapshotTree(a.cwd);
      if (!cur) return;
      s.cur = cur;
      const list = await numstat(a.cwd, base, cur);
      s.stats = { lines: list.reduce((n, f) => n + f.added + f.removed, 0), files: list.length, list };
      const reason = overLimit(s.stats, cutoffOf(limits()), 0, s.room);
      if (reason && !s.held) {
        s.held = true; s.reason = `${reason} (the cutoff, a little above the budget)`;
        a.cli?.stop(a.config.provider);
        emit({ t: 'notice', text: `Review needed: ${a.config.name} was cut off because ${reason}. Open Review to approve, edit or send it back.` });
      }
      announce(id);
    }).catch(() => {});
    return s.measuring;
  }

  return {
    view,
    begin,

    /** Chat events from a main agent: remember what it said, and re-measure after each finished edit. */
    onEvent(a, ev) {
      if (!a?.cli || !ev) return;
      const id = a.config.id;
      if (ev.k === 'msg' && ev.role === 'assistant' && ev.done && ev.text) lastText.set(id, clip(ev.text.trim(), 600));
      if (ev.k !== 'tool' || ev.cls !== 'edit') return;
      const s = stateOf(id);
      let change = s.changes.find((c) => c.id === ev.id);
      if (!change) {
        const counted = countEdit(ev.name, ev.detail) || {};
        const files = [counted.file, ...(ev.detail?.changes || []).map((c) => c?.path)].filter(Boolean);
        change = { id: ev.id, file: files[0] || ev.summary || '', note: lastText.get(id) || '', added: counted.added || 0, removed: counted.removed || 0,
          old: clip(counted.old, SNIPPET), new: clip(counted.new, SNIPPET), status: ev.status || 'running', at: Date.now() };
        s.changes.push(change);
        if (s.changes.length > MAX_CHANGES) s.changes.shift();
      }
      if (ev.status && ev.status !== change.status) change.status = ev.status;
      if (ev.status === 'done') measure(a);
    },

    /** Called before an edit tool runs (Claude, when the CLI asks first). Returns a refusal message or null. */
    denyTool(a, name, input) {
      if (!a?.cli || !EDIT_TOOLS.has(name)) return null;
      const cut = cutoffOf(limits());
      if (!cut.enabled) return null;
      const s = stateOf(a.config.id);
      if (s.held) return `Tandem review limit: ${s.reason}. Stop making changes and tell the user to review them in Tandem; do not try again until they approve.`;
      const e = countEdit(name, input);
      if (!e) return null;
      const reason = overLimit(s.stats, cut, e.added + e.removed, s.room);
      if (!reason) return null;
      s.held = true; s.reason = `${reason} (the cutoff, a little above the budget)`;
      announce(a.config.id);
      emit({ t: 'notice', text: `Review needed: ${a.config.name} was cut off because its next edit would pass the cutoff (${reason}).` });
      return `Tandem review limit: this edit would take the batch past the hard cutoff (${reason}). Stop now: summarise what you changed and what is left, and tell the user to review in Tandem. Do not retry or split this edit.`;
    },

    /** The text that goes into the agent's standing instructions: the budget, and how to work within it. */
    promptBlock() {
      const l = limits();
      if (!l.enabled) return '';
      const cut = cutoffOf(l);
      return `[Review budget set by the user in Tandem]
The user reviews your changes in batches of about ${l.maxLines} changed lines (added plus removed) across at most ${l.maxFiles} files. Plan within that.${cut.enabled ? ` Tandem cuts you off mid-job at ${cut.maxLines} lines or ${cut.maxFiles} files, so stop at a component boundary well before that.` : ''}
- Before you edit anything, estimate how big the request is. If it will not fit in one batch, do not start all of it: split it into components that can each be reviewed on their own, say what each one is and roughly how big, then do only the first.
- When a component is finished, stop. Say what changed and why, a few sentences per file, and ask the user to review it in the Tandem Review window. Do not start the next component until the user tells you to continue.
- If the user asks for something much bigger than one batch in one go, say so and propose the split instead of attempting it.
- Reading, explaining and answering questions are not limited.`;
    },

    /** A job ended: if it left the batch over budget, hold the next task until the user has reviewed. */
    async onTurnEnd(a) {
      if (!a?.cli) return;
      const id = a.config.id;
      const s = stateOf(id);
      await measure(a);
      const reason = overLimit(s.stats, limits(), 0, s.room);
      if (reason && !s.held) {
        s.held = true; s.reason = reason;
        emit({ t: 'notice', text: `Review needed: ${a.config.name} finished a job that left ${reason}. Open Review before the next task.` });
      }
      announce(id);
    },

    /** Refuses a new task while changes are waiting. */
    guardSend(a) {
      if (!a?.cli || !limits().enabled) return;
      const s = stateOf(a.config.id);
      if (s.held) throw new Error(`Review ${a.config.name}'s last job first (${s.reason}). Open Review and approve it, or change the limit in Settings.`);
    },

    /** Called when the user sends a task, so the starting snapshot exists before any edit. */
    onSend(a) { if (a?.cli) begin(a); },

    /** The user approves this batch: the next one starts from here. */
    async approve(a) {
      const id = a.config.id;
      const s = stateOf(id);
      await s.measuring;
      s.base = null; s.baseP = null; s.cur = null; s.stats = { lines: 0, files: 0, list: [] };
      s.changes = []; s.held = false; s.reason = ''; s.room = 0;
      await begin(a);
      announce(id);
      return view(id);
    },

    /** Limits were changed in Settings: a held batch may now be fine, and a fine one may now be held. */
    async recheck(a) {
      const s = stateOf(a.config.id);
      await measure(a);
      if (s.held && !overLimit(s.stats, limits(), 0, s.room)) { s.held = false; s.reason = ''; }
      announce(a.config.id);
    },

    async patchFor(a, file) {
      const s = stateOf(a.config.id);
      await s.measuring;
      const base = await begin(a);
      const cur = await snapshotTree(a.cwd);
      if (!base || !cur) return '';
      return patch(a.cwd, base, cur, file || undefined);
    },

    /**
     * The user's edit, or a question about a piece of code. Neither touches the agent's folder: the text goes to
     * the agent that made the change, which applies it, answers, or pushes back.
     */
    propose(a, { kind, file, before, after, code, question, note }) {
      if (!a?.cli) throw new Error('Review works with Claude and Codex CLI agents.');
      const id = a.config.id;
      const s = stateOf(id);
      const name = String(file || '').slice(0, 300);
      let text;
      if (kind === 'edit') {
        if (typeof after !== 'string' || !after.trim() || after.length > 20000 || String(before ?? '').length > 20000) throw new Error('Edit the code, and keep it under 20,000 characters.');
        text = [`[Review edit from the user. Nothing in your folder was changed by this.]`,
          `The user edited this part of ${name} in the Tandem review window and proposes it instead of what is there now.`,
          'Current:', '```', String(before ?? ''), '```', 'Proposed by the user:', '```', after, '```',
          note ? `The user's note: ${clip(String(note), 1000)}` : '',
          'Review it. If it is correct, apply it with a small edit. If not, explain why and offer an alternative. Do not change anything else.'].filter(Boolean).join('\n');
        s.held = false; s.reason = '';
        s.room = Math.max(s.room, s.stats.lines + PROPOSAL_ROOM);
      } else if (kind === 'ask') {
        if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new Error('Write a question of up to 4,000 characters.');
        text = [`[Question from the user about a change in ${name}. Answer it; do not edit files unless the user asks you to.]`,
          'Code:', '```', clip(String(code ?? ''), 20000), '```', `Question: ${question.trim()}`].join('\n');
      } else throw new Error('Unknown review action.');
      announce(id);
      a.cli.send(a.config.provider, text);
    },
  };
}
