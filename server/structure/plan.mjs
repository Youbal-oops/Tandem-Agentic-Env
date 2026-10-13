// Deciding which top-level pieces of a file may move into their own files. Language-neutral: each language
// adapter turns a file into "units" and this decides the grouping. It only ever errs toward keeping things
// together, because a wrong split changes behaviour and an extra grouping does not.
//
// A unit is { id, names[], refs:Set, assigns:Set, mustStay, exported, pos }:
//   names     what the piece declares (a function, a class, a constant ...)
//   refs      every other name it mentions (over-approximated: a shadowed name still counts)
//   assigns   names it reassigns, which is only legal in the file that declares them
//   mustStay  cannot leave this file (uses its own path, order-sensitive setup ...)
//   exported  something outside this file may import it by name

/** Names that must not be used as file names on Windows. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function fileStem(name) {
  let s = String(name || 'part').replace(/[^A-Za-z0-9_$-]+/g, '_').replace(/^[-.]+/, '');
  if (!s) s = 'part';
  if (RESERVED.test(s) || s.toLowerCase() === 'index') s = `_${s}`;
  return s.slice(0, 60);
}

/**
 * Returns { movable: [{ units, names, primary, exported }], stay: [unit ids], reason? }.
 * `movable` is empty (with a reason) when the file should be left alone.
 */
export function planGroups(units, { minGroups = 3, tinyLines = 8 } = {}) {
  const parent = units.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  const owner = new Map();
  units.forEach((u, i) => {
    for (const n of u.names) {
      if (owner.has(n)) union(owner.get(n), i); // overloads and merged declarations belong together
      else owner.set(n, i);
    }
  });
  units.forEach((u, i) => {
    for (const n of u.assigns || []) if (owner.has(n)) union(i, owner.get(n)); // reassigned state stays with its declaration
  });

  // Anything that must stay, and everything that depends on something that stays, stays.
  const stays = new Set();
  units.forEach((u, i) => { if (u.mustStay) stays.add(find(i)); });
  let changed = true;
  while (changed) {
    changed = false;
    units.forEach((u, i) => {
      if (stays.has(find(i))) return;
      for (const r of u.refs) {
        const o = owner.get(r);
        if (o !== undefined && stays.has(find(o))) { stays.add(find(i)); changed = true; return; }
      }
    });
  }

  // Mutual dependencies cannot be split without an import cycle: merge each strongly connected set.
  const edges = () => {
    const out = new Map();
    units.forEach((u, i) => {
      const g = find(i);
      if (stays.has(g)) return;
      if (!out.has(g)) out.set(g, new Set());
      for (const r of u.refs) {
        const o = owner.get(r);
        if (o === undefined) continue;
        const h = find(o);
        if (h !== g && !stays.has(h)) out.get(g).add(h);
      }
    });
    return out;
  };
  for (const comp of scc(edges())) for (const g of comp.slice(1)) union(comp[0], g);
  const stayRoots = new Set([...stays].map(find));
  stays.clear(); for (const g of stayRoots) stays.add(g);

  // A private helper used by exactly one other group goes into that group, so a file is not made per helper.
  for (let again = true; again;) {
    again = false;
    const exported = new Set();
    const users = new Map();
    units.forEach((u, i) => {
      const g = find(i);
      if (u.exported) exported.add(g);
      for (const r of u.refs) {
        const o = owner.get(r);
        if (o === undefined) continue;
        const h = find(o);
        if (h === g) continue;
        if (!users.has(h)) users.set(h, new Set());
        users.get(h).add(g);
      }
    });
    for (const [g, by] of users) {
      if (stays.has(g) || exported.has(g) || by.size !== 1) continue;
      const [h] = by;
      if (stays.has(h)) continue; // used only by what stays: it is its own file
      union(h, g); again = true; break;
    }
    for (const g of [...stays]) if (find(g) !== g) { stays.delete(g); stays.add(find(g)); }
  }

  const groups = new Map();
  units.forEach((u, i) => {
    const g = find(i);
    if (stays.has(g)) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(u);
  });
  let movable = [...groups.values()].map((us) => {
    const names = us.flatMap((u) => u.names);
    const lead = us.find((u) => u.exportedDefault) || us.find((u) => u.exported) || us[0];
    return { units: us, names, primary: lead.names[0] || names[0] || 'part', exported: us.some((u) => u.exported),
      lines: us.reduce((n, u) => n + (u.lines || 0), 0) };
  });
  // Tiny private helpers that only lean on each other share one file, instead of a file each. Nothing else
  // depends on them from inside, so they cannot form an import cycle with the pieces that use them.
  const ownerGroup = new Map();
  movable.forEach((g) => { for (const n of g.names) ownerGroup.set(n, g); });
  const tiny = new Set(movable.filter((g) => !g.exported && g.lines > 0 && g.lines <= tinyLines && !g.units.some((u) => u.assigns?.size)));
  for (let again = true; again;) {
    again = false;
    for (const g of [...tiny]) {
      const leans = g.units.flatMap((u) => [...u.refs]).map((r) => ownerGroup.get(r)).filter((o) => o && o !== g);
      if (leans.some((o) => !tiny.has(o))) { tiny.delete(g); again = true; }
    }
  }
  if (tiny.size >= 2) {
    const merged = [...tiny].flatMap((g) => g.units).sort((a, b) => a.id - b.id);
    movable = movable.filter((g) => !tiny.has(g));
    movable.push({ units: merged, names: merged.flatMap((u) => u.names), primary: 'helpers', exported: false, lines: merged.reduce((n, u) => n + (u.lines || 0), 0) });
  }
  const stay = units.filter((_, i) => stays.has(find(i))).map((u) => u.id);
  if (movable.length < minGroups) return { movable: [], stay: units.map((u) => u.id), reason: `only ${movable.length} separable piece${movable.length === 1 ? '' : 's'}` };
  return { movable, stay };
}

/** Tarjan's strongly connected components over `Map<node, Set<node>>`; only components with 2+ nodes are returned. */
function scc(graph) {
  let index = 0;
  const idx = new Map(); const low = new Map(); const on = new Set(); const stack = []; const out = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index += 1; stack.push(v); on.add(v);
    for (const w of graph.get(v) || []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp);
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

/** Unique, case-insensitive-safe file stems for the groups, in order. */
export function nameFiles(groups, taken = new Set()) {
  const seen = new Set([...taken].map((s) => s.toLowerCase()));
  return groups.map((g) => {
    const base = fileStem(g.primary);
    let stem = base;
    for (let n = 2; seen.has(stem.toLowerCase()); n += 1) stem = `${base}_${n}`;
    seen.add(stem.toLowerCase());
    return stem;
  });
}
