// The Team chat's dispatcher: given one task and the agents that exist, decide who does it and on which model.
// It is plain code, not a model, so assigning costs no tokens and the same task always gets the same answer.
// Three sizes: a light task goes to a small fast model, a heavy one to the strongest, the rest to a workhorse.
// The user can always overrule it (pick the agent or the size in the Team chat).

export const TIERS = ['light', 'standard', 'heavy'];
const TIER_NAME = { light: 'Light', standard: 'Standard', heavy: 'Heavy' };

const HEAVY_MODEL = /\b(opus|fable|mythos|argon|astra|ultra|frontier|most demanding|orchestrator)\b|(^|[-\s])(pro|max)\b/i;
const LIGHT_MODEL = /\b(haiku|flash|mini|nano|lite|luna|reserve|small|tiny|instant|affordable|easier tasks|efficient|oss)\b/i;
const NOT_FOR_TASKS = /auto-review|embedding|whisper|tts|image|moderation/i;
const OLD_MODEL = /\b(older|previous generation|legacy|deprecated)\b/i;

/** How big a model is, from its id plus whatever its provider says about it. `null` means it is not a model to hand tasks to. */
export function tierOfModel(id, about = '') {
  const text = `${id} ${about}`;
  if (NOT_FOR_TASKS.test(text)) return null;
  if (LIGHT_MODEL.test(text)) return 'light';
  if (HEAVY_MODEL.test(text)) return 'heavy';
  return 'standard';
}

// Some providers list one model several times, once per reasoning level (…-low, …-medium, …-high).
const LEVEL = /-(low|medium|high|xhigh)$/;
const LEVEL_FOR = { light: ['low', 'medium', 'high', 'xhigh'], standard: ['medium', 'high', 'low', 'xhigh'], heavy: ['high', 'xhigh', 'medium', 'low'] };

/**
 * The model an agent should use for a task of this size, from `models` ([{ id, label?, about? }], best first).
 * Returns { id, label, tier, exact } or null when the agent offers no choice (it then keeps its own default).
 */
export function modelFor(models, tier) {
  const usable = (models || []).map((m, order) => ({ ...m, order, tier: tierOfModel(m.id, `${m.label || ''} ${m.about || ''}`), old: OLD_MODEL.test(`${m.label || ''} ${m.about || ''}`) })).filter((m) => m.tier);
  if (!usable.length) return null;
  // The size asked for first, then the nearest: a light task may use a standard model, never the other way round by choice.
  const fallback = { light: ['light', 'standard', 'heavy'], standard: ['standard', 'heavy', 'light'], heavy: ['heavy', 'standard', 'light'] }[tier];
  for (const t of fallback) {
    const pool = usable.filter((m) => m.tier === t);
    if (!pool.length) continue;
    const level = (m) => { const l = m.id.match(LEVEL)?.[1]; return l ? LEVEL_FOR[tier].indexOf(l) : 0; };
    pool.sort((a, b) => Number(a.old) - Number(b.old) || level(a) - level(b) || a.order - b.order);
    const m = pool[0];
    return { id: m.id, label: m.label || m.id, tier: m.tier, exact: t === tier };
  }
  return null;
}

const HEAVY_TASK = [
  [/\b(architect\w*|redesign|design (a|the|an)\b|system design)/i, 'it is a design question'],
  [/\b(refactor|rewrite|restructure|migrat\w+|port (it|this|the))\b/i, 'it reshapes existing code'],
  [/\b(security|vulnerab\w+|audit|threat model|race condition|deadlock|memory leak|concurren\w+)\b/i, 'it needs careful reasoning'],
  [/\b(whole|entire|across the) (codebase|project|repo\w*|app)\b|\bfrom scratch\b|\bend[- ]to[- ]end\b/i, 'it spans the whole project'],
  [/\b(root cause|hard bug|flaky|intermittent|optimi[sz]e|performance|scal(e|ing|ability))\b/i, 'it is a hard problem'],
];
const LIGHT_TASK = [
  [/\b(typo|spelling|wording|grammar|rename|reword|capitali[sz]e)\b/i, 'it is a small text change'],
  [/\b(comment|docstring|readme|changelog|log message|tooltip|label)\b/i, 'it only touches words'],
  [/\b(format|lint|prettier|indent\w*|sort (the )?imports|unused import|bump|version number)\b/i, 'it is routine tidying'],
  [/\b(quick|tiny|small|simple|trivial|one[- ]line\w*|just (change|add|remove|fix))\b/i, 'you called it small'],
  [/^(what|where|which|who|when|is|are|does|do|can|list|show|tell me|summari[sz]e|explain)\b/i, 'it is a question, not a build'],
];
const MULTI = /\b(and then|then|also|as well|after that|afterwards|in parallel|at the same time|both of|two (independent |separate )?things|three (independent |separate )?things|and tell me|and also)\b|;|\n\s*(\d+[.)]|[-*])\s/i;
const CHANGE = /\b(add|fix|implement|build|create|write|refactor|rename|update|remove|delete|migrate|change|make|convert|install|set ?up|replace|move|rewrite|generate|scaffold|wire|hook up|run|test|deploy)\b/i;
const QUESTION = /^(what|where|which|who|when|why|how|is|are|does|do|can|could|should|list|show|tell me|summari[sz]e|explain|review|describe)\b|\?\s*$/i;
// Asking for ideas or advice is a question even when it names a change: "what else should I add", "any suggestions to improve it".
const ADVICE = /\b(what (else|other|more|should|would|could)|which .{0,30}should|should i|would you|could you suggest|any (ideas|suggestions|thoughts)|ideas? (for|to|on)|suggest(ions)?|recommend\w*|advice|opinion|thoughts on|pros and cons|is it worth|how (do|can|should|would) (i|we))\b/i;

/** Size up one task: { tier, kind: 'change' | 'question', why }. */
export function classifyTask(text) {
  const t = String(text || '').trim();
  const asks = (QUESTION.test(t) || ADVICE.test(t)) && !/\b(and|then) (fix|change|implement|update|add)\b/i.test(t);
  const kind = asks ? 'question' : CHANGE.test(t) ? 'change' : 'question';
  const steps = (t.match(/^\s*(\d+[.)]|[-*•])\s+/gm) || []).length;
  for (const [re, why] of HEAVY_TASK) if (re.test(t)) return { tier: 'heavy', kind, why };
  if (t.length > 900) return { tier: 'heavy', kind, why: 'it is a long, detailed brief' };
  if (steps >= 5) return { tier: 'heavy', kind, why: `it has ${steps} parts` };
  // Asking for several things is not a small request, whatever small words it uses ("a one-line guess").
  if (MULTI.test(t) || steps >= 2) return { tier: 'standard', kind, why: 'it has several parts' };
  if (t.length <= 400 && steps < 3) for (const [re, why] of LIGHT_TASK) if (re.test(t)) return { tier: 'light', kind, why };
  if (t.length < 60 && kind === 'question') return { tier: 'light', kind, why: 'it is a short question' };
  return { tier: 'standard', kind, why: steps >= 3 ? `it has ${steps} parts` : 'it is ordinary coding work' };
}

const READ_ONLY = new Set(['plan', 'read']);

/**
 * Choose who does a task. `agents`: [{ id, name, provider, models: [{ id, label?, about? }], current, busy, available, mode, turns, fixedModel }].
 * `want`: { agent?, tier? } are the user's own choices and always win.
 * Returns { agent, name, model (null = keep the agent's default), modelLabel, tier, kind, reason, note } or { error }.
 */
// A message that carries on from the last one: a correction, a clarification, "also…", "what about…".
const FOLLOW_UP = /^(that'?s|thats|that|this|it|those|these|also|and|but|no\b|nope|yes\b|yeah|ok(ay)?\b|actually|instead|then|now|i mean|i meant|i ment|what about|how about|same|again|more|another|continue|go on|keep going)\b|\b(i meant|i mean|i ment|you (said|suggested|mentioned|wrote)|your (answer|list|plan|reply|suggestion)s?|the above|as well|like you said|from before|not that)\b/i;
/** True when `text` reads as a follow-up to the last Team message (it is short, or it plainly refers back). */
export function isFollowUp(text, recent = []) {
  if (!recent.length) return false;
  const t = String(text || '').trim();
  return FOLLOW_UP.test(t) || (t.length < 40 && !/\b(new task|unrelated|different)\b/i.test(t) && /\b(it|that|this|them|those)\b/i.test(t));
}

/** `recent`: the last few Team messages, oldest first: [{ text, agent, result }]. */
export function pickAssignment({ text, agents, want = {}, recent = [] }) {
  const task = classifyTask(text);
  const tier = TIERS.includes(want.tier) ? want.tier : task.tier;
  const sized = TIERS.includes(want.tier) ? `${TIER_NAME[tier]} task (your choice)` : `${TIER_NAME[tier]} task: ${task.why}`;
  if (!agents.length) return { error: 'There are no agents yet. Add one first.' };

  let pool = agents;
  if (want.agent) {
    const chosen = agents.find((a) => a.id === want.agent);
    if (!chosen) return { error: 'That agent no longer exists.' };
    if (!chosen.available) return { error: `${chosen.name} is not available. Check that it is installed and signed in.` };
    if (chosen.busy) return { error: `${chosen.name} is still working. Wait for it, stop it, or let Tandem choose.` };
    pool = [chosen];
  } else {
    pool = agents.filter((a) => a.available && !a.busy);
    if (!pool.length) return { error: agents.some((a) => a.available) ? 'Every agent is busy right now. Wait for one to finish, or stop one.' : 'No agent is available. Check that they are installed and signed in.' };
    // A chat-only API model has no file or shell tools, so it only gets questions (unless nothing else is free).
    if (task.kind === 'change' && pool.some((a) => a.provider !== 'api')) pool = pool.filter((a) => a.provider !== 'api');
  }

  // A follow-up goes back to the agent that handled the last message, if it is free, so it keeps the context of that conversation.
  const last = !want.agent && isFollowUp(text, recent) ? recent.at(-1)?.agent : null;
  const continuing = last && pool.some((a) => a.id === last) ? last : null;
  if (continuing) pool = pool.filter((a) => a.id === continuing);

  const scored = pool.map((a, order) => {
    const model = a.fixedModel ? { id: a.fixedModel, label: a.fixedModel, tier: tierOfModel(a.fixedModel) || 'standard', exact: (tierOfModel(a.fixedModel) || 'standard') === tier, fixed: true } : modelFor(a.models, tier);
    let score = model ? (model.exact ? 6 : model.tier === 'light' && tier !== 'light' ? 1 : 3) : 2; // no list: its own default, size unknown
    if (task.kind === 'change' && !READ_ONLY.has(a.mode) && a.provider !== 'api') score += 1; // already allowed to edit
    return { a, model, score, order };
  }).sort((x, y) => y.score - x.score || (x.a.turns || 0) - (y.a.turns || 0) || x.order - y.order);

  const { a, model } = scored[0];
  const using = model ? model.label : `${a.name}'s default model`;
  const fit = !model ? '' : model.exact ? '' : ` (its closest to ${tier}; it has no ${tier} model)`;
  const who = want.agent ? `${a.name} (your choice)` : continuing ? `It follows on from your last message, so ${a.name} keeps that conversation` : `${a.name} is free`;
  let note = '';
  if (task.kind === 'change' && a.provider === 'api') note = `${a.name} is a chat-only model: it can advise, but it cannot change files.`;
  else if (task.kind === 'change' && READ_ONLY.has(a.mode)) note = `${a.name} is in a read-only mode, so it will propose the change, not make it. Switch its mode to let it edit.`;
  return {
    agent: a.id, name: a.name, model: model && !model.fixed ? model.id : null, modelLabel: using, tier, kind: task.kind, followUp: !!continuing,
    reason: `${sized}. ${who} and will use ${using}${fit}.`, note,
  };
}
