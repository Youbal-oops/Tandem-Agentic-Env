// The numbers the planets and the info panel are drawn from: context size, limits, tools, sub-agents.

export const freshStats = () => ({
  ctxUsed: 0,
  ctxWindow: 200000,
  tokens: { fresh: 0, cached: 0, out: 0, think: 0 },
  cache: 0,
  limits: { five: null, seven: null },
  toolTotal: 0,
  byClass: {},
  mcp: [],
  compactions: 0,
  errors: 0,
  denials: 0,
  thinking: false,
});

/** What is running right now, which sub-agents exist, which files were edited, and the current plan. */
function derive(a, rel) {
  const running = [];
  const subagents = [];
  const touched = new Map();
  let plan = [];
  for (const e of a.events) {
    if (e.k === 'tool') {
      if ((e.status === 'running' || e.status === 'awaiting') && e.cls !== 'plan') running.push(e.cls || 'other');
      if (e.cls === 'agent') subagents.push({ id: e.id, name: e.summary || 'sub-agent', status: e.status });
      if (e.cls === 'edit' && e.status === 'done') {
        const p = e.detail?.file_path || e.detail?.notebook_path;
        if (p) touched.set(rel(p), (touched.get(rel(p)) || 0) + 1);
        for (const c of e.detail?.changes || []) if (c.path) touched.set(rel(c.path), (touched.get(rel(c.path)) || 0) + 1);
      }
    } else if (e.k === 'plan') plan = e.items || [];
  }
  return { running: running.slice(0, 12), subagents: subagents.slice(-6), touched: [...touched].slice(-12).map(([p, n]) => ({ p, n })), plan };
}

/** The `meta` block sent to the browser for one agent. */
export function buildMeta(a, { specs, rel }) {
  const s = a.stats;
  const d = derive(a, rel);
  return {
    busy: a.busy,
    mode: a.mode,
    model: a.model,
    modelPref: a.modelPref,
    effort: a.effort,
    session: !!a.sessionId,
    running: !!a.proc,
    cost: a.cost,
    turns: a.turns,
    awaiting: a.approvals.size,
    available: !!specs[a.id],
    stats: {
      ctx: { used: s.ctxUsed, window: s.ctxWindow },
      tokens: s.tokens,
      cache: s.cache,
      limits: s.limits,
      tools: { total: s.toolTotal, byClass: s.byClass, running: d.running },
      subagents: d.subagents,
      mcp: s.mcp,
      plan: d.plan,
      touched: d.touched,
      compactions: s.compactions,
      errors: s.errors,
      denials: s.denials,
      thinking: s.thinking,
    },
  };
}
