// Reading a unified diff (git diff output) into pieces the review window can show.

/** Split a unified diff into hunks of { header, rows: [{ kind, text }] }. */
export function parseHunks(text) {
  const hunks = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('@@')) { cur = { header: line, rows: [] }; hunks.push(cur); continue; }
    if (!cur || line.startsWith('\\')) continue;
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line) && !cur.rows.length) continue;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    cur.rows.push({ kind, text: line.slice(1) });
  }
  return hunks.map((h) => ({ ...h, rows: h.rows.length && h.rows.at(-1).text === '' && h.rows.at(-1).kind === 'ctx' ? h.rows.slice(0, -1) : h.rows }));
}
