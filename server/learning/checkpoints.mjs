// The checkpoint cycle for a main agent in learning mode (build -> design -> implement -> report).
// This is plain state with no I/O, so it is easy to reason about and test. The app, not the model,
// decides when an agent may leave read-only work; see session.mjs for how this is enforced.
//
//   build      reason about the problem together: the user's approach first, then options
//   design     a design has been put to the user; implementation needs it confirmed (or an explicit skip)
//   implement  the user approved; the agent may change files for exactly this step
//   report     the step is done; the next message starts a new cycle

export const STAGES = ['build', 'design', 'implement', 'report'];
export const MAX_FILES = 40;

export const freshCheckpoint = () => ({ stage: 'build', designConfirmed: false, skipped: false, request: '', design: '', choices: [], files: [], startedAt: 0 });

/** What the browser needs to draw the stepper. */
export const publicView = (cp) => ({ stage: cp.stage, designConfirmed: cp.designConfirmed, skipped: cp.skipped });

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** A message from the user. After a finished step it starts a new cycle; while still reasoning it is just more discussion. */
export function onUserMessage(cp, text) {
  if (cp.stage === 'report') Object.assign(cp, freshCheckpoint());
  if (!cp.request) { cp.request = clip(text, 300); cp.startedAt = Date.now(); }
  return cp;
}

/** The agent put a design to the user as a selection card or message. */
export function onDesignProposed(cp, summary) {
  if (cp.stage === 'implement' || cp.stage === 'report') return cp;
  cp.stage = 'design';
  if (summary) cp.design = clip(summary, 600);
  return cp;
}

/** The user said "confirm" to the design (card answer or the Confirm design button). */
export function onDesignConfirmed(cp, { design, choices } = {}) {
  if (cp.stage === 'implement' || cp.stage === 'report') return cp;
  cp.stage = 'design';
  cp.designConfirmed = true;
  if (design) cp.design = clip(design, 600);
  if (Array.isArray(choices)) cp.choices = choices.map((c) => clip(c, 160)).filter(Boolean).slice(0, 6);
  return cp;
}

/** The user pressed Approve & implement. Without a confirmed design they must say they are skipping it. */
export function beginImplement(cp, { skipDesign = false } = {}) {
  if (!cp.designConfirmed && !skipDesign) throw new Error('Confirm the design first, or choose to skip the design checkpoint for a small change.');
  cp.skipped = !cp.designConfirmed;
  cp.stage = 'implement';
  cp.files = [];
  return cp;
}

export function noteFile(cp, file) {
  if (cp.stage !== 'implement' || !file || cp.files.includes(file) || cp.files.length >= MAX_FILES) return;
  cp.files.push(String(file));
}

export function finishImplement(cp) {
  cp.stage = 'report';
  return cp;
}

/** True when an answer to a selection card means "confirm". */
export const isConfirm = (label) => /^\s*confirm\b/i.test(String(label ?? ''));

/** True when a selection card is a design checkpoint (it offers a Confirm option). */
export const isDesignCard = (questions) => Array.isArray(questions) && questions.some((q) => (q?.options || []).some((o) => isConfirm(o?.label)));
