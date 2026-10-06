// Learner profile: which technologies the user actually works with, by how often they come up.
// Every user message that names a technology, and every file an agent edits for them, adds one to that
// technology's count. A technology counts as "known" once it has come up KNOWN_AT times.

export const KNOWN_AT = 3;
const MAX_TECHS = 60;
const MAX_COUNT = 100000;

const MENTION = [
  ['JavaScript', /\bjavascript\b/], ['TypeScript', /\btypescript\b/], ['React', /\breact\b/], ['Next.js', /\bnext\.?js\b/],
  ['Node.js', /\bnode(?:\.?js)?\b/], ['Python', /\bpython\b/], ['Java', /\bjava\b/], ['SQL', /\bsql\b/], ['Postgres', /\bpostgres(?:ql)?\b/],
  ['Supabase', /\bsupabase\b/], ['Docker', /\bdocker\b/], ['Git', /\bgit\b/], ['Testing', /\b(?:tests?|testing|unit tests?)\b/],
  ['CSS', /\bcss\b/], ['HTML', /\bhtml\b/], ['API', /\bapis?\b/], ['Authentication', /\bauth(?:entication)?\b/], ['Security', /\bsecurity\b/],
  ['Rust', /\brust\b/], ['Go', /\bgolang\b|\bgo (?:module|routine|code)\b/], ['Vue', /\bvue\b/], ['Svelte', /\bsvelte\b/], ['Tailwind CSS', /\btailwind\b/],
];

const EXT = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'React', ts: 'TypeScript', tsx: 'React', py: 'Python', css: 'CSS', scss: 'CSS',
  html: 'HTML', sql: 'SQL', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP', swift: 'Swift', vue: 'Vue',
  svelte: 'Svelte', c: 'C/C++', cpp: 'C/C++', h: 'C/C++', sh: 'Shell', ps1: 'PowerShell', tf: 'Terraform', prisma: 'Prisma',
};
const FILE = { dockerfile: 'Docker', 'docker-compose.yml': 'Docker', 'package.json': 'Node.js', 'tsconfig.json': 'TypeScript' };

/** Technologies named in a message, each once. */
export function techFromText(text) {
  const t = String(text || '').toLowerCase();
  return MENTION.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/** Technologies implied by an edited file's name, each once. TSX and JSX also count as TypeScript and JavaScript. */
export function techFromPath(file) {
  const base = String(file || '').split(/[\\/]/).pop().toLowerCase();
  const out = new Set();
  if (FILE[base]) out.add(FILE[base]);
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (EXT[ext]) out.add(EXT[ext]);
  if (ext === 'tsx') out.add('TypeScript');
  if (ext === 'jsx') out.add('JavaScript');
  return [...out];
}

/** Add one to each technology's count. Returns true if a technology just crossed into "known". */
export function bump(counts, techs) {
  let crossed = false;
  for (const name of techs) {
    if (typeof name !== 'string' || (!(name in counts) && Object.keys(counts).length >= MAX_TECHS)) continue;
    const before = counts[name] || 0;
    counts[name] = Math.min(MAX_COUNT, before + 1);
    if (before < KNOWN_AT && counts[name] >= KNOWN_AT) crossed = true;
  }
  return crossed;
}

/** Technologies worked with often enough to count as known, most frequent first. */
export function knownStack(counts, limit = 12) {
  return Object.entries(counts || {}).filter(([, n]) => n >= KNOWN_AT).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name, n]) => ({ name, n }));
}

/** Counts from saved data. Older profiles only had a list of names, which count as known. */
export function loadCounts(profile) {
  const counts = {};
  if (profile?.counts && typeof profile.counts === 'object' && !Array.isArray(profile.counts)) {
    for (const [name, n] of Object.entries(profile.counts).slice(0, MAX_TECHS)) if (typeof name === 'string' && name.length <= 40 && Number.isFinite(n) && n > 0) counts[name] = Math.min(MAX_COUNT, Math.floor(n));
  } else if (Array.isArray(profile?.observed)) {
    for (const name of profile.observed.slice(0, MAX_TECHS)) if (typeof name === 'string' && name.length <= 40) counts[name] = KNOWN_AT;
  }
  return counts;
}
