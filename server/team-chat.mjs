// The Team chat as it is saved: what the browser sends is cleaned here, so only known fields, of the right kind and
// size, are ever stored.

const KEEP = 40; // tasks kept per repository
const MAX_TOTAL = 800 * 1024; // characters kept per repository
const STATES = new Set(['assigning', 'working', 'waiting', 'done', 'failed', 'sent', 'asked', 'held']);
const TIERS = new Set(['light', 'standard', 'heavy']);
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const num = (v) => (Number.isFinite(v) ? v : undefined);

export function cleanEntry(e) {
  if (!e || typeof e !== 'object' || typeof e.text !== 'string') return null;
  const out = {
    id: str(e.id, 80) || String(Date.now()), text: e.text.slice(0, 40000), at: num(e.at) || Date.now(), runId: str(e.runId, 80),
    agent: str(e.agent, 60), name: str(e.name, 60), modelLabel: str(e.modelLabel, 120), reason: str(e.reason, 600), by: str(e.by, 300), note: str(e.note, 400),
    result: str(e.result, 60000), error: str(e.error, 1200), asked: str(e.asked, 600), tier: TIERS.has(e.tier) ? e.tier : undefined, kind: e.kind === 'change' || e.kind === 'question' ? e.kind : undefined,
    state: STATES.has(e.state) ? e.state : 'sent', followUp: e.followUp === true ? true : undefined,
    steps: Number.isInteger(e.steps) && e.steps >= 0 ? Math.min(e.steps, 100000) : undefined,
  };
  if (Array.isArray(e.handoff)) out.handoff = e.handoff.slice(0, 3).filter((h) => h && typeof h.id === 'string').map((h) => ({ id: h.id.slice(0, 60), name: str(h.name, 60) || h.id, why: str(h.why, 200) || '' }));
  if (e.changes && typeof e.changes === 'object' && Number.isFinite(e.changes.files)) {
    out.changes = { files: e.changes.files, added: num(e.changes.added) || 0, removed: num(e.changes.removed) || 0,
      list: (Array.isArray(e.changes.list) ? e.changes.list : []).slice(0, 6).filter((f) => f && typeof f.path === 'string').map((f) => ({ path: f.path.slice(0, 300), added: num(f.added) || 0, removed: num(f.removed) || 0 })) };
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** The last KEEP tasks, cleaned, and small enough to store: the oldest go first. */
export function cleanTeamChat(entries) {
  const list = (Array.isArray(entries) ? entries : []).map(cleanEntry).filter(Boolean).slice(-KEEP);
  while (list.length > 1 && JSON.stringify(list).length > MAX_TOTAL) list.shift();
  return list;
}
