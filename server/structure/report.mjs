// Languages Tandem looks at but does not rewrite. Splitting C, C++ and EJS safely needs the build, the header
// relationships or the template scope, so the tool only reports which files are big and where a split would
// likely go. The numbers are approximate on purpose, and nothing is written.

const FUNCTION = /^(?:[A-Za-z_][\w:<>,*&\s~]*?[\s*&])?([A-Za-z_~][\w:~]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/;
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'catch', 'defined']);

export function reportCpp({ file, text, minLines = 150 }) {
  const lines = text.split('\n');
  if (lines.length < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const names = [];
  let depth = 0;
  let inBlockComment = false;
  for (const raw of lines) {
    let line = raw;
    if (inBlockComment) { const end = line.indexOf('*/'); if (end < 0) continue; line = line.slice(end + 2); inBlockComment = false; }
    line = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
    if (line.includes('/*')) { inBlockComment = true; line = line.slice(0, line.indexOf('/*')); }
    if (depth === 0 && !line.startsWith('#') && /^[A-Za-z_]/.test(line)) {
      const m = FUNCTION.exec(line.trim());
      if (m && !NOT_FUNCTIONS.has(m[1])) names.push(m[1]);
    }
    for (const ch of line) { if (ch === '{') depth += 1; else if (ch === '}') depth = Math.max(0, depth - 1); }
  }
  return { ok: true, report: true, file, lines: lines.length, approxFunctions: names.length, names: names.slice(0, 60),
    note: 'C and C++ are not split automatically: where a function goes depends on headers, linkage and the build files.' };
}

export function reportEjs({ file, text, minLines = 150 }) {
  const lines = text.split('\n');
  if (lines.length < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const includes = [...text.matchAll(/<%[-=]?\s*include\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  return { ok: true, report: true, file, lines: lines.length, approxFunctions: 0, names: includes.slice(0, 40),
    note: 'EJS templates are not split automatically: partials share the template scope, so the cut points need a person. Large blocks between <% %> tags are the usual place.' };
}
