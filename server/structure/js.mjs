// Splitting a JavaScript / JSX / TypeScript / TSX ES module into one file per piece.
//
// The original path stays: it keeps whatever has to stay and re-exports the pieces, so nothing that
// imports it changes. Pieces live in a folder next to it. What may move is decided by plan.mjs; this file
// reads the module, writes the files, and then checks that the public exports are exactly the same.

import path from 'node:path';
import { createRequire } from 'node:module';

// The parser is a native add-on: load it only when a file is actually read, so a problem with it can only
// ever disable this feature and never stop Tandem from starting.
let oxc;
const parseSync = (...args) => (oxc ||= createRequire(import.meta.url)('oxc-parser')).parseSync(...args);
import { nameFiles, planGroups } from './plan.mjs';

export const JS_EXT = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.mts']);

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'parent', 'raw']);
const PATHY = new Set(['__dirname', '__filename', 'require', 'module', 'exports', 'eval']);
const TYPE_ONLY = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration']);
const DECLARATIONS = new Set(['FunctionDeclaration', 'ClassDeclaration', 'VariableDeclaration', 'TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSEnumDeclaration', 'TSDeclareFunction']);
const REJECT = new Set(['TSImportEqualsDeclaration', 'TSExportAssignment', 'TSNamespaceExportDeclaration']);

const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';

/** Identifier names bound or assigned by a pattern (`a`, `{ a, b: c }`, `[a, ...rest]`). */
function patternNames(node, out = []) {
  if (!isNode(node)) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) patternNames(e, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'TSParameterProperty': patternNames(node.parameter, out); break;
    default: break;
  }
  return out;
}

/** Every name a statement mentions, every name it reassigns, and whether it depends on where its file is. */
function analyze(node, jsx = []) {
  const refs = new Set(); const assigns = new Set();
  let pathy = false;
  const visit = (n) => {
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    if (!isNode(n)) return;
    switch (n.type) {
      case 'Identifier':
        refs.add(n.name);
        if (PATHY.has(n.name)) pathy = true;
        visit(n.typeAnnotation); visit(n.decorators); // a typed parameter or binding names its type
        return;
      case 'JSXElement': case 'JSXFragment':
        // The classic JSX transform calls React.createElement (or the @jsx pragma) without naming it in the source.
        for (const j of jsx) refs.add(j);
        for (const [k, v] of Object.entries(n)) if (!SKIP_KEYS.has(k)) visit(v);
        return;
      case 'JSXIdentifier':
        if (/^[A-Z]/.test(n.name)) refs.add(n.name);
        return;
      case 'MetaProperty': pathy = true; return;
      case 'ImportExpression':
        if (n.source?.type === 'Literal' && typeof n.source.value === 'string' && n.source.value.startsWith('.')) pathy = true;
        visit(n.source);
        return;
      case 'MemberExpression':
        visit(n.object);
        if (n.computed) visit(n.property);
        return;
      case 'JSXMemberExpression': visit(n.object); return;
      case 'JSXAttribute': visit(n.value); return;
      case 'JSXNamespacedName': return;
      case 'LabeledStatement': visit(n.body); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'Property':
        if (n.computed) visit(n.key);
        visit(n.value);
        return;
      case 'MethodDefinition': case 'PropertyDefinition': case 'AccessorProperty': case 'TSAbstractMethodDefinition': case 'TSAbstractPropertyDefinition':
        if (n.computed) visit(n.key);
        visit(n.value); visit(n.decorators); visit(n.typeAnnotation);
        return;
      case 'TSPropertySignature': case 'TSMethodSignature':
        if (n.computed) visit(n.key);
        visit(n.typeAnnotation); visit(n.params); visit(n.returnType);
        return;
      case 'TSEnumMember': visit(n.initializer); return;
      case 'TSQualifiedName': visit(n.left); return;
      case 'AssignmentExpression':
        for (const name of patternNames(n.left)) assigns.add(name);
        visit(n.left); visit(n.right);
        return;
      case 'UpdateExpression':
        if (n.argument?.type === 'Identifier') assigns.add(n.argument.name);
        visit(n.argument);
        return;
      case 'ForInStatement': case 'ForOfStatement':
        if (n.left?.type !== 'VariableDeclaration') for (const name of patternNames(n.left)) assigns.add(name);
        visit(n.left); visit(n.right); visit(n.body);
        return;
      default:
        for (const [k, v] of Object.entries(n)) if (!SKIP_KEYS.has(k)) visit(v);
    }
  };
  visit(node);
  return { refs, assigns, pathy };
}

/** Names this export statement makes public: 'default', 'name', or '*' for a star re-export. */
function exportedNames(program) {
  const out = new Set();
  for (const s of program.body) {
    if (s.type === 'ExportDefaultDeclaration') out.add('default');
    else if (s.type === 'ExportAllDeclaration') out.add(s.exported ? s.exported.name ?? s.exported.value : `*:${s.source.value}`);
    else if (s.type === 'ExportNamedDeclaration') {
      if (s.declaration) {
        const d = s.declaration;
        if (d.type === 'VariableDeclaration') for (const x of d.declarations) for (const n of patternNames(x.id)) out.add(n);
        else if (d.id?.name) out.add(d.id.name);
      }
      for (const sp of s.specifiers || []) out.add(sp.exported.name ?? sp.exported.value);
    }
  }
  return out;
}

const posix = (p) => p.split(path.sep).join('/');
const rel = (fromDir, to) => { const r = path.posix.relative(fromDir, to); return r.startsWith('.') ? r : `./${r}`; };

/**
 * Split one module. `file` is the repo-relative path (posix), `existing` the names already present next to it.
 * Returns { ok: false, reason } or { ok: true, root, parts, files }.
 */
export function splitJs({ file, text, minLines = 150, minGroups = 3, existing = new Set() }) {
  const lineCount = text.split('\n').length;
  if (lineCount < minLines) return { ok: false, reason: `under ${minLines} lines` };
  const ext = path.posix.extname(file);
  const base = path.posix.basename(file, ext);
  const dir = path.posix.dirname(file);
  let parsed;
  try { parsed = parseSync(path.posix.basename(file), text); } catch (e) { return { ok: false, reason: `parser failed: ${String(e.message).slice(0, 80)}` }; }
  if (parsed.errors.length) return { ok: false, reason: 'has syntax errors' };
  const { program, comments } = parsed;
  const body = program.body;
  if (!body.some((s) => /^(Import|Export)/.test(s.type))) return { ok: false, reason: 'not an ES module (CommonJS or a plain script)' };
  if (body.some((s) => REJECT.has(s.type))) return { ok: false, reason: 'uses TypeScript module syntax that cannot be split safely' };

  // ---- where each statement starts, counting the comments that belong to it
  const starts = []; // [start including its own comment block]
  let prevEnd = 0;
  body.forEach((s, k) => {
    let begin = s.start;
    const gap = comments.filter((c) => c.start >= prevEnd && c.end <= s.start).sort((a, b) => b.start - a.start);
    let cursor = s.start;
    for (const c of gap) {
      const between = text.slice(c.end, cursor);
      if (/\n\s*\n/.test(between) || (k === 0 && c.start === 0 && /^#!/.test(text))) break; // a blank line ends the block
      if (k > 0 && !/\n/.test(text.slice(prevEnd, c.start))) break; // same line as the previous statement: theirs
      begin = c.start; cursor = c.start;
    }
    starts.push(begin);
    prevEnd = s.end;
  });
  const dirs = new Set();
  const jsxNames = ['React', ...[...text.matchAll(/@jsx(?:Frag)?\s+([A-Za-z_$][\w$.]*)/g)].map((m) => m[1].split('.')[0])];
  const directive = (s) => s.type === 'ExpressionStatement' && typeof s.directive === 'string';

  // ---- imports
  const imports = []; // { node, source, kind, specs:[{ local, imported, kind:'default'|'namespace'|'named', type }], opaque }
  body.forEach((s, k) => {
    if (s.type !== 'ImportDeclaration') return;
    const specs = (s.specifiers || []).map((sp) => ({
      local: sp.local.name,
      imported: sp.type === 'ImportSpecifier' ? (sp.imported.name ?? sp.imported.value) : null,
      kind: sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named',
      type: sp.importKind === 'type',
    }));
    imports.push({ k, node: s, source: s.source.value, raw: s.source.raw, typeOnly: s.importKind === 'type', specs,
      opaque: !specs.length || (s.attributes && s.attributes.length > 0) || specs.some((sp) => sp.kind === 'named' && !/^[A-Za-z_$][\w$]*$/.test(sp.imported)) });
  });
  const importBinding = new Map(); // local name -> import record
  for (const imp of imports) for (const sp of imp.specs) importBinding.set(sp.local, imp);

  // ---- units
  const units = [];
  const stmtOfUnit = new Map();
  const rootStatements = []; // statement indexes that always stay
  body.forEach((s, k) => {
    if (s.type === 'ImportDeclaration') return;
    if (directive(s)) { dirs.add(k); return; }
    let decl = null; let exported = false; let exportedDefault = false;
    if (s.type === 'ExportNamedDeclaration' && s.declaration) { decl = s.declaration; exported = true; }
    else if (s.type === 'ExportDefaultDeclaration' && (s.declaration.type === 'FunctionDeclaration' || s.declaration.type === 'ClassDeclaration') && s.declaration.id) { decl = s.declaration; exported = true; exportedDefault = true; }
    else if (DECLARATIONS.has(s.type)) decl = s;
    if (!decl || !DECLARATIONS.has(decl.type)) {
      const info = analyze(s, jsxNames);
      const unit = { id: units.length, k, names: [], refs: info.refs, assigns: info.assigns, mustStay: true, exported: false, node: s, typeOnly: false };
      if (s.type === 'TSModuleDeclaration' && s.id?.name) unit.names = [s.id.name];
      units.push(unit); stmtOfUnit.set(unit.id, k); rootStatements.push(k);
      return;
    }
    const names = decl.type === 'VariableDeclaration' ? decl.declarations.flatMap((d) => patternNames(d.id)) : decl.id?.name ? [decl.id.name] : [];
    const info = analyze(s, jsxNames);
    for (const n of names) info.refs.delete(n); // a piece does not depend on itself
    const unit = { id: units.length, k, lines: text.slice(starts[k], s.end).split('\n').length, names, refs: info.refs, assigns: new Set([...info.assigns].filter((n) => !names.includes(n))), mustStay: info.pathy || !names.length,
      exported, exportedDefault, node: s, decl, typeOnly: TYPE_ONLY.has(decl.type) };
    units.push(unit); stmtOfUnit.set(unit.id, k);
  });
  // A binding from an import that cannot be re-written (side effects, attributes) forces its users to stay.
  for (const u of units) for (const r of u.refs) if (importBinding.get(r)?.opaque && importBinding.get(r).specs.length) u.mustStay = true;

  const plan = planGroups(units, { minGroups });
  if (!plan.movable.length) return { ok: false, reason: plan.reason || 'nothing can move' };

  // ---- file names
  const folderName = existing.has(base.toLowerCase()) ? `${base}_parts` : base;
  const folder = path.posix.join(dir === '.' ? '' : dir, folderName);
  const stems = nameFiles(plan.movable);
  const movedName = new Map(); // name -> { group, stem, exportedAs }
  plan.movable.forEach((g, i) => {
    g.stem = stems[i];
    g.fileRel = `${folder}/${g.stem}${ext}`;
    for (const u of g.units) for (const n of u.names) movedName.set(n, { g, u });
  });

  // Which pieces must be exported from their own file: anything another piece or the root uses.
  const rootRefs = new Set();
  for (const k of rootStatements) for (const r of analyze(body[k], jsxNames).refs) rootRefs.add(r);
  for (const id of plan.stay) for (const r of units[id].refs) rootRefs.add(r);
  const usedByOthers = new Set();
  for (const g of plan.movable) for (const u of g.units) for (const r of u.refs) {
    const m = movedName.get(r);
    if (m && m.g !== g) usedByOthers.add(r);
  }
  for (const r of rootRefs) if (movedName.has(r)) usedByOthers.add(r);

  // ---- specifier style
  const relSources = imports.map((i) => i.source).filter((s) => s.startsWith('.'));
  const sawExt = relSources.some((s) => /\.(mjs|cjs|jsx?|tsx?)$/.test(s));
  const sawJs = relSources.some((s) => /\.m?jsx?$/.test(s));
  const isTs = /^\.m?tsx?$/.test(ext);
  const useExt = sawExt || !isTs;
  const specExt = isTs && sawJs ? ext.replace(/^\.(m?)tsx?$/, '.$1js') : ext;
  const siblingSpec = (stem, fromDir) => `${rel(fromDir, `${folder}/${stem}`)}${useExt ? specExt : ''}`;
  const rebase = (source, toDir) => (source.startsWith('.') ? rel(toDir, path.posix.join(dir, source)) : source);
  const quote = (raw) => (raw && raw[0] === '"' ? '"' : "'");

  // ---- unit files
  const dirText = [...dirs].map((k) => text.slice(starts[k], body[k].end)).join('\n');
  const files = [];
  const parts = [];
  for (const g of plan.movable) {
    const myNames = new Set(g.names);
    const refs = new Set(g.units.flatMap((u) => [...u.refs]));
    const importLines = [];
    // original imports this piece uses
    const usedImports = new Map();
    for (const r of refs) { const imp = importBinding.get(r); if (imp && !myNames.has(r)) { if (!usedImports.has(imp)) usedImports.set(imp, new Set()); usedImports.get(imp).add(r); } }
    for (const imp of imports) {
      const names = usedImports.get(imp);
      if (!names) continue;
      importLines.push(renderImport(imp, names, rebase(imp.source, folder), quote(imp.raw)));
    }
    // other pieces it uses
    const siblings = new Map();
    for (const r of refs) {
      const m = movedName.get(r);
      if (!m || m.g === g) continue;
      if (!siblings.has(m.g)) siblings.set(m.g, []);
      siblings.get(m.g).push({ name: r, unit: m.u });
    }
    for (const [sg, list] of siblings) {
      const spec = siblingSpec(sg.stem, folder);
      const def = list.filter((x) => x.unit.exportedDefault && x.name === x.unit.names[0]);
      const typed = list.filter((x) => !def.includes(x) && x.unit.typeOnly);
      const named = list.filter((x) => !def.includes(x) && !x.unit.typeOnly);
      if (def.length || named.length) importLines.push(`import ${def.length ? def[0].name : ''}${def.length && named.length ? ', ' : ''}${named.length ? `{ ${named.map((x) => x.name).join(', ')} }` : ''} from '${spec}';`);
      if (typed.length) importLines.push(`import type { ${typed.map((x) => x.name).join(', ')} } from '${spec}';`);
    }
    const pieces = g.units.map((u) => {
      const s = u.node;
      let t = text.slice(starts[u.k], s.end);
      const needsExport = !u.exported && u.names.some((n) => usedByOthers.has(n));
      if (needsExport) { const at = s.start - starts[u.k]; t = `${t.slice(0, at)}export ${t.slice(at)}`; }
      return t;
    });
    const content = `${[dirText, importLines.join('\n')].filter(Boolean).join('\n')}${dirText || importLines.length ? '\n\n' : ''}${pieces.join('\n\n')}\n`;
    files.push({ rel: g.fileRel, content });
    parts.push({ file: g.fileRel, names: g.names, lines: content.split('\n').length - 1 });
  }

  // ---- the original file: stays where it is, minus what moved, plus imports and re-exports of it
  const edits = [];
  const movedKs = new Set(plan.movable.flatMap((g) => g.units.map((u) => u.k)));
  for (const k of movedKs) {
    let end = body[k].end;
    while (text[end] === ' ' || text[end] === '\t') end += 1;
    if (text[end] === '\r') end += 1;
    if (text[end] === '\n') end += 1;
    edits.push({ start: starts[k], end, with: '' });
  }
  const rootStillUses = new Set(rootRefs);
  for (const imp of imports) {
    const used = imp.specs.filter((sp) => rootStillUses.has(sp.local));
    let end = imp.node.end;
    if (text[end] === '\r') end += 1;
    if (text[end] === '\n') end += 1;
    if (imp.opaque || used.length === imp.specs.length) continue;
    if (!used.length) edits.push({ start: starts[imp.k], end, with: '' });
    else edits.push({ start: imp.node.start, end: imp.node.end, with: renderImport(imp, new Set(used.map((u) => u.local)), imp.source, quote(imp.raw)) });
  }
  const bring = []; const reexport = [];
  const byGroup = new Map();
  for (const n of rootRefs) {
    const m = movedName.get(n);
    if (!m) continue;
    if (!byGroup.has(m.g)) byGroup.set(m.g, []);
    byGroup.get(m.g).push({ name: n, unit: m.u });
  }
  for (const [g, list] of byGroup) {
    const spec = siblingSpec(g.stem, dir === '.' ? '' : dir);
    const def = list.filter((x) => x.unit.exportedDefault && x.name === x.unit.names[0]);
    const typed = list.filter((x) => !def.includes(x) && x.unit.typeOnly);
    const named = list.filter((x) => !def.includes(x) && !x.unit.typeOnly);
    if (def.length || named.length) bring.push(`import ${def.length ? def[0].name : ''}${def.length && named.length ? ', ' : ''}${named.length ? `{ ${named.map((x) => x.name).join(', ')} }` : ''} from '${spec}';`);
    if (typed.length) bring.push(`import type { ${typed.map((x) => x.name).join(', ')} } from '${spec}';`);
  }
  for (const g of plan.movable) {
    const spec = siblingSpec(g.stem, dir === '.' ? '' : dir);
    const values = []; const types = [];
    for (const u of g.units) {
      if (!u.exported) continue;
      if (u.exportedDefault) values.push('default');
      else for (const n of u.names) (u.typeOnly ? types : values).push(n);
    }
    if (values.length) reexport.push(`export { ${values.join(', ')} } from '${spec}';`);
    if (types.length) reexport.push(`export type { ${types.join(', ')} } from '${spec}';`);
  }
  const lastImport = imports.length ? Math.max(...imports.map((i) => i.node.end)) : null;
  const firstK = body.findIndex((s, k) => !directive(s) && s.type !== 'ImportDeclaration');
  const block = ['// Standardized by Tandem: the pieces of this module are in ./' + folderName + '/. Its exports are unchanged.', ...bring, ...reexport].join('\n');
  if (lastImport !== null) {
    let at = lastImport;
    if (text[at] === '\r') at += 1;
    if (text[at] === '\n') at += 1;
    edits.push({ start: at, end: at, with: `${block}\n` });
  } else {
    const at = firstK >= 0 ? starts[firstK] : text.length;
    edits.push({ start: at, end: at, with: `${block}\n\n` });
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let root = text;
  for (const e of edits) root = root.slice(0, e.start) + e.with + root.slice(e.end);
  root = root.replace(/(\r?\n){4,}/g, '\n\n\n');

  // Keep the file's own line endings in every piece.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const norm = (t) => t.replace(/\r?\n/g, eol);
  root = `${norm(root).replace(/\s+$/, '')}${eol}`;
  for (const f of files) f.content = norm(f.content);
  const result = { ok: true, root, files, parts, folder, lines: lineCount, rootLines: root.split('\n').length };
  const scope = new Set([...units.flatMap((u) => u.names), ...importBinding.keys()]);
  const bad = verifyJs({ file, original: text, root, files, scope });
  return bad ? { ok: false, reason: bad } : result;
}

function renderImport(imp, names, source, q) {
  const specs = imp.specs.filter((sp) => names.has(sp.local));
  const def = specs.find((s) => s.kind === 'default');
  const ns = specs.find((s) => s.kind === 'namespace');
  const named = specs.filter((s) => s.kind === 'named');
  const parts = [];
  if (def) parts.push(def.local);
  if (ns) parts.push(`* as ${ns.local}`);
  if (named.length) parts.push(`{ ${named.map((s) => `${s.type && !imp.typeOnly ? 'type ' : ''}${s.imported === s.local ? s.local : `${s.imported} as ${s.local}`}`).join(', ')} }`);
  return `import ${imp.typeOnly ? 'type ' : ''}${parts.join(', ')} from ${q}${source}${q};`;
}

/**
 * Every identifier a program uses, read by walking all of its nodes (deliberately simpler than analyze(), so a
 * mistake in one is unlikely to be repeated in the other). Property names and labels are not uses.
 */
function usedNames(program, jsx = []) {
  const out = new Set();
  let hasJsx = false;
  const walk = (n, parent, key) => {
    if (Array.isArray(n)) { for (const x of n) walk(x, parent, key); return; }
    if (!isNode(n)) return;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') hasJsx = true;
    if ((n.type === 'ExportNamedDeclaration' && n.source) || n.type === 'ExportAllDeclaration') return; // names from another module
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') {
      const skip = (key === 'property' && parent?.type === 'MemberExpression' && !parent.computed)
        || (key === 'property' && parent?.type === 'JSXMemberExpression')
        || (key === 'key' && !parent?.computed && parent?.type !== 'TSEnumMember')
        || (key === 'id' && parent?.type === 'TSEnumMember')
        || (key === 'name' && (parent?.type === 'JSXAttribute' || parent?.type === 'JSXOpeningElement' || parent?.type === 'JSXClosingElement') && n.type === 'JSXIdentifier' && !/^[A-Z]/.test(n.name))
        || (key === 'label') || (key === 'exported') || (key === 'imported');
      if (!skip && !(n.type === 'JSXIdentifier' && key === 'name' && parent?.type === 'JSXAttribute')) out.add(n.name);
    }
    for (const [k, v] of Object.entries(n)) if (!SKIP_KEYS.has(k)) walk(v, n, k);
  };
  walk(program, null, null);
  if (hasJsx) for (const j of jsx) out.add(j);
  return out;
}

/** After splitting: everything parses, the public exports are the same, and every sibling import resolves. */
export function verifyJs({ file, original, root, files, scope = new Set() }) {
  const parse = (name, src) => { try { const r = parseSync(path.posix.basename(name), src); return r.errors.length ? null : r.program; } catch { return null; } };
  const before = parse(file, original);
  const after = parse(file, root);
  if (!before || !after) return 'the result did not parse';
  const a = exportedNames(before); const b = exportedNames(after);
  if (a.size !== b.size || [...a].some((n) => !b.has(n))) return 'the public exports would change';
  // Independent safety net: every name from the original module that a file mentions must be declared or
  // imported in that file. Read from raw tokens, so it does not share the splitter's own mistakes.
  const have = (prog) => new Set(prog.body.flatMap((s) => {
    if (s.type === 'ImportDeclaration') return s.specifiers.map((sp) => sp.local.name);
    const d = s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration' ? s.declaration : s;
    if (!d) return [];
    if (d.type === 'VariableDeclaration') return d.declarations.flatMap((x) => patternNames(x.id));
    return d.id?.name ? [d.id.name] : [];
  }));
  const missing = (src, prog) => {
    const known = have(prog);
    const jsx = ['React', ...[...src.matchAll(/@jsx(?:Frag)?\s+([A-Za-z_$][\w$.]*)/g)].map((m) => m[1].split('.')[0])];
    for (const name of usedNames(prog, jsx)) if (scope.has(name) && !known.has(name)) return name;
    return null;
  };
  const lost = missing(root, after);
  if (lost) return `the original file would lose "${lost}"`;
  for (const f of files) {
    const prog = parse(f.rel, f.content);
    const gone = prog && missing(f.content, prog);
    if (gone) return `${f.rel} would be missing "${gone}"`;
  }
  const exportsOf = new Map();
  for (const f of files) {
    const prog = parse(f.rel, f.content);
    if (!prog) return `${f.rel} did not parse`;
    exportsOf.set(posix(f.rel), { prog, names: exportedNames(prog) });
  }
  for (const f of files) {
    const dir = path.posix.dirname(f.rel);
    for (const s of exportsOf.get(posix(f.rel)).prog.body) {
      if (s.type !== 'ImportDeclaration' || !s.source.value.startsWith('./')) continue;
      const target = [...exportsOf.keys()].find((k) => k.replace(/\.[^.]+$/, '') === path.posix.join(dir, s.source.value).replace(/\.[^./]+$/, '') || k === path.posix.join(dir, s.source.value));
      if (!target) continue;
      const have = exportsOf.get(target).names;
      for (const sp of s.specifiers) {
        const want = sp.type === 'ImportDefaultSpecifier' ? 'default' : sp.type === 'ImportSpecifier' ? (sp.imported.name ?? sp.imported.value) : null;
        if (want && !have.has(want)) return `${f.rel} imports ${want} that ${target} does not export`;
      }
    }
  }
  return null;
}
