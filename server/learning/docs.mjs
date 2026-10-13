// The two learning documents kept in the project's .tandem/learning folder, both plain Markdown:
//
//   learning.md         what was built, explained for this user: one section per approved step, newest last
//   learningcontext.md  what every agent should know about teaching this user: who they are, which ways of
//                       explaining worked, what they have grasped, what to teach next. Agents read it at the
//                       start of each session, so Claude and Codex teach consistently.
//
// Agents write a "Learning note" and "Teaching notes" block at the end of their report; Tandem files them here.

import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join('.tandem', 'learning');
const LEARNING = 'learning.md';
const CONTEXT = 'learningcontext.md';
const LEARNING_HEADER = '# What we built, explained\n\nWritten by Tandem from each approved step, in plain terms for you. Newest at the bottom. Safe to edit.\n';
const MAX_SECTIONS = 100;
const MAX_ITEMS = 15;
const KINDS = [['pattern', 'Teaching patterns'], ['progress', 'Progress'], ['next', 'Next to teach']];

const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');
export const learningDir = (repo) => path.join(repo, DIR);
export const learningFile = (repo) => path.join(learningDir(repo), LEARNING);
export const contextFile = (repo) => path.join(learningDir(repo), CONTEXT);

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/** The text under a `## Heading` (case-insensitive) up to the next `## ` heading, or ''. */
export function section(text, heading) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*${heading}\\s*:?\\s*$`, 'i').test(l.trim()));
  if (start < 0) return '';
  const body = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,3}\s/.test(l)) break; body.push(l); }
  return body.join('\n').trim();
}

/** `- Pattern: ...`, `- Progress: ...` and `- Next: ...` lines from an agent's report. */
export function parseTeaching(report) {
  const scope = section(report, 'Teaching notes') || String(report || '');
  const out = { pattern: [], progress: [], next: [] };
  for (const line of scope.split('\n')) {
    const m = /^\s*[-*]?\s*(pattern|progress|next)\s*:\s*(.+)$/i.exec(line);
    if (m && out[m[1].toLowerCase()].length < 5) out[m[1].toLowerCase()].push(one(m[2], 240));
  }
  return out;
}

/** Add one approved step to learning.md. `note` is the agent's Learning note; without one the whole report is used. */
export function appendLearning(repo, { at = Date.now(), title, request, files = [], note, report, level }) {
  const body = (String(note || '').trim() || String(report || '').trim()).slice(0, 3000);
  if (!body) return false;
  const file = learningFile(repo);
  let text = read(file);
  if (!text.trim()) text = LEARNING_HEADER;
  const sections = text.split(/^## /m);
  const head = sections.shift();
  const meta = [level && `Level: ${level}`, files.length && `Files: ${files.slice(0, 12).map((f) => one(f, 100)).join(', ')}${files.length > 12 ? ` and ${files.length - 12} more` : ''}`].filter(Boolean).join(' · ');
  sections.push(`${stamp(at)} · ${one(title || request || 'Step', 100)}\n${request ? `You asked: ${one(request, 300)}\n` : ''}${meta ? `_${meta}_\n` : ''}\n${body}`);
  const kept = sections.slice(-MAX_SECTIONS);
  write(file, head.trimEnd() + '\n\n' + kept.map((s) => '## ' + s.trimEnd()).join('\n\n') + '\n');
  return true;
}

function listOf(text, heading) {
  return section(text, heading).split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean);
}

/** Merge a step's teaching notes and the current profile into learningcontext.md. Lists the user edited are kept. */
export function updateContext(repo, teaching = { pattern: [], progress: [], next: [] }, profile = {}) {
  const file = contextFile(repo);
  const existing = read(file);
  const lists = {};
  for (const [key, heading] of KINDS) {
    const old = listOf(existing, heading);
    const fresh = teaching[key] || [];
    if (key === 'next') lists[key] = fresh.length ? fresh : old; // what comes next is replaced, not accumulated
    else {
      const seen = new Set(old.map((x) => x.toLowerCase()));
      lists[key] = [...old, ...fresh.filter((x) => !seen.has(x.toLowerCase()))].slice(-MAX_ITEMS);
    }
  }
  const user = [
    `- Experience: ${profile.level || 'familiar'}; teaching style: ${profile.style || 'plain'}; checkpoints: ${profile.checkpoints || 'normal'}`,
    profile.familiar && `- Already knows: ${one(profile.familiar, 300)}`,
    profile.learning && `- Wants to learn: ${one(profile.learning, 300)}`,
    profile.known?.length && `- Works with often: ${profile.known.slice(0, 8).map((k) => `${k.name} (${k.n})`).join(', ')}`,
  ].filter(Boolean).join('\n');
  const bullets = (a) => (a.length ? a.map((x) => `- ${x}`).join('\n') : '- (nothing recorded yet)');
  write(file, `# Learning context\n\nShared by every agent working with this user, and re-read at the start of each session. Agents add to it after each approved step. Edit it freely: lists are kept as you leave them.\n\n## User\n${user}\n\n## Teaching patterns\n${bullets(lists.pattern)}\n\n## Progress\n${bullets(lists.progress)}\n\n## Next to teach\n${bullets(lists.next)}\n`);
}

/** The context file as prompt text, or '' when nothing has been recorded. */
export function contextPrompt(repo, chars = 2200) {
  const text = read(contextFile(repo)).trim();
  if (!text || !/^- (?!\(nothing)/m.test(section(text, 'Teaching patterns') + section(text, 'Progress') + section(text, 'Next to teach'))) return '';
  return `[Learning context: what is known about teaching this user. Use it, and add to it in your Teaching notes.]\n${text.replace(/^# .*\n+/, '').slice(0, chars)}`;
}

export function readDocs(repo) {
  return { learning: read(learningFile(repo)).slice(-60000), context: read(contextFile(repo)).slice(0, 20000) };
}
