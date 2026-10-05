import fs from 'node:fs';
import path from 'node:path';

export const CONTEXT_DIR = '.tandem';
export const CONTEXT_FILE = 'PROJECT_CONTEXT.md';

export function ensureProjectContext(repo) {
  const dir = path.join(repo, CONTEXT_DIR);
  const file = path.join(dir, CONTEXT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# Project context\n\nThis is Tandem's shared project context. Every agent uses it.\n\n## What we are building\n\nDescribe the project here.\n\n## Decisions\n\n- Add confirmed architecture and product decisions here.\n\n## Working agreements\n\n- Add conventions, constraints and commands agents should know.\n`);
  return { file, text: fs.readFileSync(file, 'utf8').slice(0, 12000) };
}
