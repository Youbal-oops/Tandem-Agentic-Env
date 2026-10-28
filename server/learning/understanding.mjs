// What Tandem learns about the person from how they talk, and how it knows an agent is satisfied.
// Everything here is plain functions over plain data (no I/O), so it is easy to test.
//
//   readiness   the agent writes one line, "READY TO BUILD: <the clear answer>", when it has been satisfied. The app
//               will not let implementation start before it (see checkpoints.mjs), and any new message from the
//               user takes it back, so the agent has to be satisfied again.
//   delegation  the user handing the thinking back ("you decide", "think of it yourself"). It is never accepted as an
//               answer: the agent is told so, and it is counted as a habit.
//   skills      what the agent concludes about the user's level in each technology, from questioning them.
//   behavior    counts of habits seen in the user's messages, and short observations the agent writes down.

export const LEVELS = ['new', 'familiar', 'confident'];
const MAX_SKILLS = 60;
const MAX_NOTES = 12;
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Phrases that hand the decision, or the thinking, back to the agent.
const DELEGATION = /\b(you (?:decide|choose|pick|figure(?: it)? out|think|know best|handle it)|think (?:of|about) it (?:on your own|yourself)|figure it out(?: yourself)?|(?:it'?s )?up to you|whatever you (?:think|want|prefer|like|decide)|i (?:don'?t|do not) (?:care|mind|know)|your call|surprise me|use your (?:best )?judg(?:e)?ment|just (?:do|build|make|code|write|implement|go with) it|(?:don'?t|do not|stop) (?:ask|asking)(?: me)?(?: (?:any )?(?:more )?questions)?|no more questions)\b/i;
// Asking to hurry or to skip the process.
const RUSH = /\b(hurry|asap|quickly|right now|skip (?:the )?(?:questions|design|checkpoint|checkpoints|review))\b/i;

/** The phrase if the message hands the decision back, otherwise null. */
export function delegationIn(text) {
  const m = DELEGATION.exec(String(text || ''));
  return m ? m[0].trim() : null;
}

export const freshBehavior = () => ({ messages: 0, chars: 0, short: 0, delegations: 0, rushes: 0, notes: [] });

/** Saved behavior, checked: numbers are numbers, notes are short strings. */
export function loadBehavior(saved) {
  const b = freshBehavior();
  if (!saved || typeof saved !== 'object') return b;
  for (const k of ['messages', 'chars', 'short', 'delegations', 'rushes']) if (Number.isFinite(saved[k]) && saved[k] > 0) b[k] = Math.min(1e7, Math.floor(saved[k]));
  if (Array.isArray(saved.notes)) b.notes = saved.notes.filter((n) => n && typeof n.note === 'string').slice(-MAX_NOTES).map((n) => ({ note: clip(n.note, 200), at: Number(n.at) || 0 }));
  return b;
}

/** Count what a message from the user shows. `answering` is true while the agent is still questioning them. */
export function trackMessage(behavior, text, { answering = false } = {}) {
  const t = String(text || '').trim();
  if (!t) return behavior;
  behavior.messages++;
  behavior.chars += t.length;
  if (answering && t.length < 15) behavior.short++;
  if (delegationIn(t)) behavior.delegations++;
  if (RUSH.test(t)) behavior.rushes++;
  return behavior;
}

/** The line that says an agent is satisfied, or null. Only a line of its own counts, so quoting the words does not. */
export function readyIn(text) {
  const m = /^[ \t>*_`-]*READY TO BUILD:[ \t]*(\S.*)$/im.exec(String(text || ''));
  const note = m ? clip(m[1].replace(/^[*_`\s]+|[*_`]+$/g, ''), 240) : '';
  return note && !note.startsWith('<') ? note : null; // a template such as "<one sentence>" is a quote, not a claim
}

/** The "## Learner notes" block an agent ends a message with: `{ skills: [{ name, level, evidence }], behavior: [text] }`. */
export function learnerNotes(text) {
  const body = /^#{1,4}[ \t]*Learner notes[ \t]*\r?\n([\s\S]*?)(?=^#{1,4}[ \t]|(?![\s\S]))/im.exec(String(text || ''));
  const out = { skills: [], behavior: [] };
  if (!body) return out;
  for (const raw of body[1].split(/\r?\n/)) {
    const line = raw.replace(/^[ \t]*[-*][ \t]*/, '').trim();
    const skill = /^skill:[ \t]*(.+?)[ \t]*=[ \t]*(new|familiar|confident)\b[ \t]*(?:[(:-][ \t]*(.*?)\)?)?$/i.exec(line);
    if (skill) { out.skills.push({ name: clip(skill[1], 40), level: skill[2].toLowerCase(), evidence: clip(skill[3], 160) }); continue; }
    const behavior = /^behaviou?r:[ \t]*(.+)$/i.exec(line);
    if (behavior) out.behavior.push(clip(behavior[1], 200));
  }
  out.skills = out.skills.filter((s) => s.name).slice(0, 8);
  out.behavior = out.behavior.filter(Boolean).slice(0, 4);
  return out;
}

/** Saved skills, checked. */
export function loadSkills(saved) {
  const skills = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return skills;
  for (const [name, s] of Object.entries(saved).slice(0, MAX_SKILLS)) {
    if (name.length <= 40 && s && LEVELS.includes(s.level)) skills[name] = { level: s.level, evidence: clip(s.evidence, 160), at: Number(s.at) || 0 };
  }
  return skills;
}

/** Record what an agent concluded. Returns true if anything changed. */
export function applyNotes(profile, notes, now = Date.now()) {
  let changed = false;
  for (const s of notes.skills) {
    if (!(s.name in profile.skills) && Object.keys(profile.skills).length >= MAX_SKILLS) {
      const oldest = Object.entries(profile.skills).sort((a, b) => a[1].at - b[1].at)[0];
      delete profile.skills[oldest[0]];
    }
    const before = profile.skills[s.name];
    if (!before || before.level !== s.level || before.evidence !== s.evidence) { profile.skills[s.name] = { level: s.level, evidence: s.evidence, at: now }; changed = true; }
  }
  for (const note of notes.behavior) {
    if (profile.behavior.notes.some((n) => n.note === note)) continue;
    profile.behavior.notes = [...profile.behavior.notes, { note, at: now }].slice(-MAX_NOTES);
    changed = true;
  }
  return changed;
}

/** The "what we have learned about this person" lines for the agent's prompt. Empty when nothing is known yet. */
export function observedLines(profile) {
  const lines = [];
  const skills = Object.entries(profile.skills || {}).sort((a, b) => b[1].at - a[1].at);
  if (skills.length) lines.push(`Assessed skills (your own earlier judgments; revise them when you see otherwise): ${skills.map(([name, s]) => `${name} = ${s.level}${s.evidence ? ` (${s.evidence})` : ''}`).join('; ')}`);
  const b = profile.behavior;
  if (b?.messages) {
    const habits = [`${b.messages} messages`, b.delegations && `handed the decision back ${b.delegations} time${b.delegations > 1 ? 's' : ''}`, b.short && `${b.short} very short answer${b.short > 1 ? 's' : ''} to your questions`, b.rushes && `asked to hurry or skip steps ${b.rushes} time${b.rushes > 1 ? 's' : ''}`].filter(Boolean);
    lines.push(`Observed habits: ${habits.join(', ')}.`);
  }
  if (b?.notes?.length) lines.push(`Your notes on how they behave: ${b.notes.map((n) => n.note).join(' | ')}`);
  return lines;
}

/** The note added to a message that hands the thinking back, so the agent refuses it. */
export const delegationNote = (phrase) => `\n\n[Tandem: the user just tried to hand the thinking back to you ("${clip(phrase, 60)}"). That is not an answer, and you are not allowed to accept it. Do not decide for them, do not assume, and do not write code. Say so in one line, then ask one narrower question: offer two concrete options with their trade-offs and ask which they would pick and why.]`;
