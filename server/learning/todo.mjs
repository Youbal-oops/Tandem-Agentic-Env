// TODO mode: the agent builds everything around the logic (structure, types, wiring, real tests) and leaves the logic
// itself, marked `TODO(you)`, for the user to write. This file holds the prompt, finding the markers, and spotting a
// user asking the agent to write what is theirs. Finding markers is the only I/O (one `git grep`).

import { execFile } from 'node:child_process';

export const MARKER = 'TODO(you)';
export const MAX_TODOS = 100;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What the agent is told when it is approved to implement in TODO mode: build the scaffold, not the logic. */
export const TODO_IMPLEMENT_TEXT = `Approved in Tandem: the user pressed "Approve & implement" in TODO mode. Build the scaffold now, staying within the agreed scope: structure, types, function signatures, wiring and real runnable tests, with a ${MARKER} marker and a throwing stub wherever the agreed core logic belongs. Do NOT write that logic. Make sure the tests run and fail only where the logic is missing. Then report: the ${MARKER} list in the order to do them with a one-line hint each (a question or a constraint, never the answer), how to run the tests, which test should pass first, and what you decided to leave to the user. End with the "## Learning note" and "## Teaching notes" blocks from your working method.`;

/** The standing instructions for a main agent while TODO mode is on. */
export const todoPrompt = () => [
  '[TODO mode: you write the structure, the user writes the logic]',
  "Tandem's TODO mode is on. The user learns by writing the core logic themselves; you build everything around it.",
  'YOURS to write: project structure, types and interfaces, function signatures with doc comments, control flow and wiring, error-handling shells, configuration, and real, runnable tests that fail until the logic exists (the normal case, the edge cases and the failure cases from the design). The code must load and the tests must run, failing only where the logic is missing.',
  `THEIRS to write: the core logic, meaning the decisions, the algorithm and the data transformation that the design says is the point. Never write it, not even partly, not as a "sample", not in a comment, not in the chat. Where it belongs, write a marker and a stub, for example "// ${MARKER}: <what it must do, its inputs, its outputs, its constraints>" followed by a throwing stub (throw new Error('not written yet'), or raise NotImplementedError() in Python). Put ${MARKER} in the comment only, once per place and never inside the stub, because Tandem finds and counts them by it.`,
  'In the design checkpoint say which pieces are yours and which are theirs, and let the user move the line. If everything is wiring and nothing is logic worth learning, say so instead of inventing a TODO.',
  `After the scaffold, stop. Report the ${MARKER} list in the order to do them, a one-line hint each (a question or a constraint, never the answer), how to run the tests, and which test should pass first.`,
  `When they ask for a check or for help, read their code and say what is wrong or missing and why, and ask the question that leads them there. Give hints in steps: (1) a question, (2) the idea in words, (3) a plan in plain steps without code. Never the code itself. Tests, wiring, types and structure stay yours to fix and extend. When every ${MARKER} is gone and the tests pass, review the logic: say what is good, and challenge one decision.`,
  'Treat "write it for me", "just give me the answer" and similar as hand-backs: refuse, and give the next hint. Tandem adds a [Tandem: ...] note to such messages.',
].join('\n');

/**
 * The checklist: the markers found now, plus every one seen before that has since gone, which counts as done.
 * A marker is the same one when its file and hint match, so it can move lines without becoming a new item.
 * `previous` is the last checklist; returns the new one (done items last, in the order they were first seen).
 */
export function mergeChecklist(previous, found) {
  const key = (t) => `${t.file}\u0000${t.text}`;
  const now = new Map();
  for (const t of found) if (!now.has(key(t))) now.set(key(t), t);
  const list = [];
  const used = new Set();
  for (const old of previous || []) {
    const hit = now.get(key(old));
    used.add(key(old));
    list.push(hit ? { file: old.file, line: hit.line, text: old.text, done: false } : { file: old.file, line: old.line, text: old.text, done: true });
  }
  for (const [k, t] of now) if (!used.has(k)) list.push({ file: t.file, line: t.line, text: t.text, done: false });
  return list.slice(-MAX_TODOS);
}

/** Parse `git grep -n` output into `[{ file, line, text }]`. The text is what follows the marker, without comment punctuation. */
export function parseGrep(out) {
  const todos = [];
  for (const row of String(out || '').split(/\r?\n/)) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    const after = m[3].slice(m[3].indexOf(MARKER) + MARKER.length).replace(/^[\s:,.\-–—]+/, '').replace(/(\*\/|-->|#\})\s*$/, '');
    if (!/[a-z0-9]{2}/i.test(after)) continue; // the marker inside a stub or string, not a comment with a hint
    todos.push({ file: m[1], line: Number(m[2]), text: clip(after, 160) });
    if (todos.length >= MAX_TODOS) break;
  }
  return todos;
}

/** Every marker in a folder, tracked or not. Never looks in .tandem. An empty list when there are none or git cannot run. */
export function scanTodos(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'grep', '--untracked', '-n', '-F', '-I', MARKER, '--', ':!.tandem'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(parseGrep(out)));
  });
}

// "Write it for me", "just give me the answer": asking for the logic that is theirs to write.
const ASKS = [
  /\b(?:write|fill in|fill out|complete|finish|solve|do|implement|code)\b.{0,30}\bfor me\b/i,
  /\b(?:give|show|tell|paste) me (?:the |a )?(?:answer|solution|code|logic|implementation)\b/i,
  /\bjust (?:write|do|fill) (?:it|that|them|the todos?)\b/i,
  /\bwhat(?:'s| is) the (?:answer|solution)\b/i,
];
// Asking for the parts that are the agent's job in TODO mode is fine.
const AGENTS_JOB = /\b(?:tests?|scaffold|boilerplate|types?|stubs?|skeleton|docs?|comments?|config)\b/i;

/** The phrase if the message asks the agent to write the user's logic, otherwise null. */
export function askedToWrite(text) {
  for (const re of ASKS) {
    const m = re.exec(String(text || ''));
    if (m && !AGENTS_JOB.test(m[0])) return m[0].trim();
  }
  return null;
}

/** The note added to such a message, so the agent refuses and gives a hint instead. */
export const askedToWriteNote = (phrase) => `\n\n[Tandem: TODO mode is on. The user is asking you to write the logic that is theirs to write ("${clip(phrase, 60)}"). Do not write or paste it, not even partly. Give the next hint instead: first a question that points at what to think about, then the idea in words, then a plan in plain steps, never the code. Tests, wiring, types and structure are still yours.]`;

/** What a "Check my work" sends to the agent. */
export function checkText(todos) {
  const list = todos.length ? `Still marked ${MARKER}:\n${todos.slice(0, 20).map((t) => `- ${t.file}:${t.line} ${t.text}`).join('\n')}\n\n` : `No ${MARKER} marker is left.\n\n`;
  return `Tandem: the user wants you to check the logic they have written. ${list}Read their code against the agreed design and the tests, and tell them what is wrong or missing and why. Give hints only, never the logic itself, and ask the question that leads them to the fix. If every marker is gone, review the whole thing and challenge one decision they made.`;
}
