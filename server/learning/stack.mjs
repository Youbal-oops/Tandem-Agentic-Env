// Detects the technologies a repository uses, so the learner profile can mention them without being told.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.tandem', '.next', 'release']);
const MAX_FOLDERS = 30;

const JS_DEPS = {
  react: 'React', next: 'Next.js', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@angular/core': 'Angular', solid: 'Solid',
  express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS', hono: 'Hono',
  vite: 'Vite', webpack: 'Webpack', electron: 'Electron', three: 'Three.js', tailwindcss: 'Tailwind CSS',
  typescript: 'TypeScript', jest: 'Jest', vitest: 'Vitest', playwright: 'Playwright', cypress: 'Cypress',
  prisma: 'Prisma', '@prisma/client': 'Prisma', '@supabase/supabase-js': 'Supabase', firebase: 'Firebase',
  graphql: 'GraphQL', '@trpc/server': 'tRPC', mongoose: 'MongoDB', pg: 'Postgres', ws: 'WebSockets', 'react-native': 'React Native',
};
const PY_WORDS = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI', pytest: 'pytest', sqlalchemy: 'SQLAlchemy', pandas: 'pandas', numpy: 'NumPy', torch: 'PyTorch', tensorflow: 'TensorFlow' };
const FILES = {
  'tsconfig.json': 'TypeScript', 'Cargo.toml': 'Rust', 'go.mod': 'Go', 'Gemfile': 'Ruby', 'composer.json': 'PHP', 'pubspec.yaml': 'Dart/Flutter',
  'Package.swift': 'Swift', 'Dockerfile': 'Docker', 'docker-compose.yml': 'Docker', 'docker-compose.yaml': 'Docker', 'compose.yaml': 'Docker',
  'schema.prisma': 'Prisma', 'pom.xml': 'Java', 'build.gradle': 'Java/Kotlin', 'build.gradle.kts': 'Kotlin', 'CMakeLists.txt': 'C/C++', 'Makefile': 'Make',
};

const read = (file) => { try { return fs.readFileSync(file, 'utf8').slice(0, 200000); } catch { return ''; } };

function scan(dir, found) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const has = new Set(names);
  const pkg = has.has('package.json') ? read(path.join(dir, 'package.json')) : '';
  if (pkg) {
    found.add('Node.js');
    try {
      const json = JSON.parse(pkg);
      for (const name of Object.keys({ ...json.dependencies, ...json.devDependencies })) if (JS_DEPS[name]) found.add(JS_DEPS[name]);
    } catch {}
  }
  for (const [file, label] of Object.entries(FILES)) if (has.has(file)) found.add(label);
  for (const name of names) {
    if (/\.(csproj|sln)$/.test(name)) { found.add('.NET'); found.add('C#'); }
    else if (name.endsWith('.tf')) found.add('Terraform');
  }
  const pyFiles = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'].filter((f) => has.has(f));
  if (pyFiles.length) {
    const py = pyFiles.map((f) => read(path.join(dir, f))).join('\n').toLowerCase();
    found.add('Python');
    for (const [word, label] of Object.entries(PY_WORDS)) if (new RegExp(`(^|[^a-z0-9_-])${word}([^a-z0-9_-]|$)`).test(py)) found.add(label);
  }
  if (has.has('supabase')) found.add('Supabase');
  if (has.has('prisma')) found.add('Prisma');
  if (has.has('Gemfile') && /rails/i.test(read(path.join(dir, 'Gemfile')))) found.add('Rails');
  if (has.has('composer.json') && /laravel/i.test(read(path.join(dir, 'composer.json')))) found.add('Laravel');
  if ((has.has('pom.xml') || has.has('build.gradle') || has.has('build.gradle.kts')) && /spring/i.test(read(path.join(dir, has.has('pom.xml') ? 'pom.xml' : has.has('build.gradle') ? 'build.gradle' : 'build.gradle.kts')))) found.add('Spring');
  if (has.has('.github')) { try { if (fs.readdirSync(path.join(dir, '.github')).includes('workflows')) found.add('GitHub Actions'); } catch {} }
}

/** Technologies found in the repository root and its immediate sub-folders (for monorepos), in a stable order. */
export function detectStack(repo) {
  const found = new Set();
  if (!repo) return [];
  scan(repo, found);
  let folders = [];
  try { folders = fs.readdirSync(repo, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP.has(d.name) && !d.name.startsWith('.')).slice(0, MAX_FOLDERS); } catch {}
  for (const d of folders) scan(path.join(repo, d.name), found);
  // TypeScript implies JavaScript tooling; plain JS projects have no tsconfig.
  if (found.has('Node.js') && !found.has('TypeScript')) found.add('JavaScript');
  return [...found].sort((a, b) => a.localeCompare(b));
}
