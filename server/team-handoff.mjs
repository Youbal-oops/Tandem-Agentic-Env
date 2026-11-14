// What the Team assistant knows about each agent's current work, and the context it hands from one agent to another.
// Both are built from what the agents have really said and done (their chats and the files they changed), not from
// anything a model wrote about them, so a hand-over can never contain an invention.

/** Marks where the user's own words start in a message that has context in front of it. */
export const REQUEST_MARK = '[Request from the user]';

const clip = (s, n) => { const t = String(s || '').replace(/\r/g, '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

/** The user's own request inside a message Tandem sent to an agent (without the context blocks in front of it). */
export function requestOf(text) {
  const t = String(text || '');
  const i = t.lastIndexOf(REQUEST_MARK);
  return (i >= 0 ? t.slice(i + REQUEST_MARK.length) : t).trim();
}

/**
 * What one agent is doing, from its snapshot `{ events, meta }`:
 * { status, task, answer, files }, where `task` is the last thing it was asked, `answer` its latest reply, and `files` the files it
 * changed most recently.
 */
export function agentBrief(snap) {
  const events = snap?.events || [];
  const meta = snap?.meta || {};
  const lastUser = [...events].reverse().find((e) => e.k === 'user');
  const lastMsg = [...events].reverse().find((e) => e.k === 'msg' && typeof e.text === 'string' && e.text.trim());
  const files = (meta.stats?.touched || []).slice(-8).map((f) => f.p).filter(Boolean);
  const status = meta.awaiting ? 'waiting for the user to approve something' : meta.busy ? 'working' : events.some((e) => e.k === 'user') ? 'idle' : 'new, nothing done yet';
  return { status, task: lastUser ? clip(requestOf(lastUser.text), 300) : '', answer: lastMsg ? clip(lastMsg.text, 2500) : '', files };
}

/**
 * The text put in front of a request when it builds on other agents' work.
 * `handoff` is [{ from, why }] (agent ids), `roster` the team with its briefs (see team-roster.mjs).
 * Returns { text, from: [{ id, name, why }] } for the agents that exist, or null when there is nothing to hand over.
 */
export function composeHandoff({ handoff, roster, sharedDir = '' }) {
  const from = [];
  const blocks = [];
  for (const h of Array.isArray(handoff) ? handoff.slice(0, 3) : []) {
    const a = roster.find((x) => x.id === h.from);
    if (!a || from.some((f) => f.id === a.id)) continue;
    const b = a.brief || {};
    if (!b.task && !b.answer && !(b.files || []).length) continue; // it has done nothing: there is nothing to hand over
    from.push({ id: a.id, name: a.name, why: clip(h.why, 200) });
    blocks.push([
      `- ${a.name} (${b.status})${b.task ? ` was asked: "${clip(b.task, 200)}"` : ''}`,
      (b.files || []).length ? `  Files it changed: ${b.files.join(', ')}` : '',
      b.answer ? `  Its latest answer:\n${clip(b.answer, 1500).split('\n').map((l) => `    ${l}`).join('\n')}` : '',
      h.why ? `  Why this matters here: ${clip(h.why, 200)}` : '',
    ].filter(Boolean).join('\n'));
  }
  if (!blocks.length) return null;
  const text = [`[Context handed over by the Team assistant]`,
    `The request below builds on work other agents did or are doing. Use it to stay consistent with them, and do not redo it. Their files are in their own folders, which you cannot see; anything they wrote for the team is in the shared folder${sharedDir ? ` (${sharedDir})` : ''}.`,
    ...blocks, '', REQUEST_MARK].join('\n');
  return { text: text.slice(0, 7000), from };
}

/** The user's answer to a question the assistant asked, put back together with the request it was about. */
export function combineAnswer(last, answer) {
  if (!last || typeof last.asked !== 'string' || !last.asked.trim()) return null;
  return `${clip(last.text, 1500)}\n\n(You were asked: "${clip(last.asked, 300)}")\nMy answer: ${answer}`;
}
