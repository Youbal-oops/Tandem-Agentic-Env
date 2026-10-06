// The learning journal: one short entry per finished step, kept in the project's own .tandem folder so it
// survives restarts, new chats and new sessions. It is plain Markdown, so you can read or edit it, and
// agents in learning mode are reminded of the latest entries so they build on what you already decided.

import fs from 'node:fs';
import path from 'node:path';

const FILE = 'LEARNING.md';
const HEADER = '# Learning journal\n\nWritten by Tandem after each approved step. Newest entries are at the bottom. Safe to edit.\n';
const MAX_ENTRIES = 200;
const FIELDS = ['Request', 'Design', 'Choices', 'Files', 'Report'];

const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

export const journalFile = (repo) => path.join(repo, '.tandem', FILE);

/** `{ at, title, request, design, skipped, choices[], files[], report, level }` as one Markdown section. */
export function entryToMarkdown(e) {
  const lines = [`## ${stamp(e.at || Date.now())} · ${one(e.title || e.request || 'Step', 100)}`];
  lines.push(`- Request: ${one(e.request, 300) || '-'}`);
  lines.push(`- Design: ${e.skipped ? 'skipped (small change)' : one(e.design, 500) || 'confirmed'}`);
  if (e.choices?.length) lines.push(`- Choices: ${e.choices.map((c) => one(c, 160)).join('; ')}`);
  if (e.files?.length) lines.push(`- Files: ${e.files.slice(0, 20).map((f) => one(f, 120)).join(', ')}${e.files.length > 20 ? ` and ${e.files.length - 20} more` : ''}`);
  lines.push(`- Report: ${one(e.report, 700) || '-'}`);
  return lines.join('\n');
}

/** Parse the file back into entries (`{ at, title, fields }`), oldest first. Hand-edited text is kept as written. */
export function parseJournal(text) {
  return String(text || '').split(/^## /m).slice(1).map((block) => {
    const [head, ...rest] = block.split('\n');
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (.*)$/.exec(head.trim());
    const fields = {};
    for (const line of rest) {
      const f = /^- (\w+): (.*)$/.exec(line);
      if (f && FIELDS.includes(f[1])) fields[f[1].toLowerCase()] = f[2];
    }
    return { at: m ? m[1] : '', title: m ? m[2] : head.trim(), fields, raw: block.trimEnd() };
  });
}

export function readEntries(repo) {
  try { return parseJournal(fs.readFileSync(journalFile(repo), 'utf8')); } catch { return []; }
}

export function appendEntry(repo, entry) {
  const file = journalFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = HEADER; }
  if (!text.trim()) text = HEADER;
  let sections = text.split(/^## /m);
  const head = sections.shift();
  sections.push(entryToMarkdown(entry).replace(/^## /, ''));
  if (sections.length > MAX_ENTRIES) sections = sections.slice(-MAX_ENTRIES);
  const out = head.trimEnd() + '\n\n' + sections.map((s) => '## ' + s.trimEnd()).join('\n\n') + '\n';
  fs.writeFileSync(file + '.tmp', out);
  fs.renameSync(file + '.tmp', file);
}

export function clearJournal(repo) {
  try { fs.rmSync(journalFile(repo)); } catch { /* nothing to clear */ }
}

/** The latest entries as prompt text, newest last, trimmed to a size the agent can afford to read. */
export function journalPrompt(repo, { entries = 5, chars = 2400 } = {}) {
  const list = readEntries(repo).slice(-entries);
  if (!list.length) return '';
  let used = 0;
  const kept = [];
  for (const e of list.reverse()) {
    const text = `${e.at} ${e.title}\n${Object.entries(e.fields).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`;
    if (used + text.length > chars && kept.length) break;
    used += text.length;
    kept.unshift(text.slice(0, chars));
  }
  return `[Learning journal: what this user already decided and learned in earlier steps. Build on it; do not re-explain it.]\n${kept.join('\n')}`;
}
