// Learning mode for one workspace: the learner profile, the read-only lock on main agents, the checkpoint
// cycle (build -> design -> implement -> report) and the journal that carries decisions between sessions.
//
// The lock is enforced here, not in the prompt: a locked agent is held in its read-only mode and refused
// ExitPlanMode until the user presses Approve & implement. Everything else in this folder is pure or file-only.

import path from 'node:path';
import { appendEntry, clearJournal, journalPrompt, readEntries } from './journal.mjs';
import { STAGES, beginImplement, finishImplement, freshCheckpoint, isConfirm, isDesignCard, noteFile, onDesignConfirmed, onDesignProposed, onUserMessage, publicView } from './checkpoints.mjs';
import { bump, knownStack, loadCounts, techFromPath, techFromText } from './knowledge.mjs';
import { detectStack } from './stack.mjs';
import { workflowPrompt } from './workflow.mjs';

const READ_ONLY = { claude: 'plan', codex: 'read' };
const LEVELS = ['new', 'familiar', 'confident'];
const STYLES = ['plain', 'examples', 'diagrams', 'questions'];
const PACES = ['light', 'normal', 'frequent'];
const IMPLEMENT_TEXT = 'Approved in Tandem: the user pressed "Approve & implement". Implement the agreed step now, staying within the agreed scope, then write the report (what changed, why, how you checked it, what the user should now understand, what comes next).';
const SKIPPED_TEXT = ' The user chose to skip the design checkpoint because this is a small change: keep it small, and say what you assumed.';

/** `ctx` supplies: saved, workingDir (current), entries, broadcast, emit, schedule. */
export function createLearning(ctx) {
  const { saved, entries, broadcast } = ctx;

  // ---------------------------------------------------------------- profile
  let profile = {
    familiar: String(saved.learnerProfile?.familiar || '').slice(0, 2000),
    learning: String(saved.learnerProfile?.learning || '').slice(0, 2000),
    counts: loadCounts(saved.learnerProfile),
    observed: [], known: [],
    level: LEVELS.includes(saved.learnerProfile?.level) ? saved.learnerProfile.level : 'familiar',
    style: STYLES.includes(saved.learnerProfile?.style) ? saved.learnerProfile.style : 'plain',
    checkpoints: PACES.includes(saved.learnerProfile?.checkpoints) ? saved.learnerProfile.checkpoints : 'normal',
  };
  let on = saved.learningMode === true;
  // `known` is what the user works with often (see knowledge.mjs); `observed` is the same list as plain names.
  const refreshKnown = () => { profile.known = knownStack(profile.counts); profile.observed = profile.known.map((k) => k.name); };
  refreshKnown();

  let stackCache = { cwd: '', at: 0, list: [] };
  const detectedStack = () => {
    if (stackCache.cwd !== ctx.workingDir || Date.now() - stackCache.at > 60000) stackCache = { cwd: ctx.workingDir, at: Date.now(), list: detectStack(ctx.workingDir) };
    return stackCache.list;
  };

  /** Count a technology each time the user brings it up. */
  function observeLearning(text) {
    const techs = techFromText(text);
    if (!techs.length) return;
    if (bump(profile.counts, techs)) { refreshKnown(); ctx.emit({ t: 'learnerprofile', learnerProfile: profile }); } else ctx.schedule();
  }

  /** ...and each time an agent finishes editing one of its files. */
  const countedEdits = new Set();
  const editPaths = (ev) => [ev.detail?.file_path, ev.detail?.notebook_path, ...(ev.detail?.changes || []).map((c) => c?.path)].filter(Boolean);
  function observeEdit(ev) {
    if (ev?.k !== 'tool' || ev.cls !== 'edit' || ev.status !== 'done' || !ev.id || countedEdits.has(ev.id)) return [];
    countedEdits.add(ev.id);
    if (countedEdits.size > 2000) countedEdits.delete(countedEdits.values().next().value);
    const paths = editPaths(ev);
    const techs = [...new Set(paths.flatMap(techFromPath))];
    if (techs.length && bump(profile.counts, techs)) { refreshKnown(); broadcast({ t: 'learnerprofile', learnerProfile: profile }); }
    return paths;
  }

  // ---------------------------------------------------------------- checkpoints
  const cpOf = (a) => (a.cp ||= freshCheckpoint());
  const announce = (a) => broadcast({ t: 'checkpoint', agent: a.config.id, checkpoint: publicView(cpOf(a)) });
  const relative = (a, file) => { const r = path.relative(a.cwd, file); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : file; };

  /** Events from a main agent: tally edits, notice a design being put to the user, and note the step's files. */
  function onAgentEvent(a, ev) {
    const paths = observeEdit(ev);
    if (!on || !a.cli) return;
    const cp = cpOf(a);
    if (paths.length && cp.stage === 'implement') for (const p of paths) noteFile(cp, relative(a, p));
    if (ev.k === 'tool' && ev.name === 'AskUserQuestion' && ev.status === 'awaiting' && isDesignCard(ev.detail?.questions)) {
      onDesignProposed(cp, ev.detail.questions[0]?.question);
      announce(a);
    } else if (ev.k === 'msg' && ev.done && ev.role === 'assistant' && /confirm and continue/i.test(ev.text || '') && cp.stage === 'build') {
      onDesignProposed(cp, '');
      announce(a);
    }
  }

  /** An approval card was answered. Answers that say Confirm confirm the design. */
  function onApproved(a, accepted) {
    if (!on || !a.cli || !accepted) return;
    const entriesList = Object.entries(accepted);
    if (!entriesList.some(([, label]) => isConfirm(label))) return;
    const choices = entriesList.filter(([, label]) => !isConfirm(label) && !/^discuss$/i.test(label)).map(([q, label]) => `${q.slice(0, 60)}: ${label}`);
    onDesignConfirmed(cpOf(a), { choices });
    announce(a);
  }

  function confirmDesign(a) {
    if (!on) throw new Error('Turn on learning mode first.');
    if (!a.cli) throw new Error('Only Claude and Codex chats have checkpoints.');
    onDesignConfirmed(cpOf(a));
    announce(a);
  }

  // ---------------------------------------------------------------- the read-only lock
  /** Put an idle main agent back into read-only mode unless the user just approved implementation. */
  function relock(a) {
    const mode = READ_ONLY[a.config.provider];
    if (!on || a.unlocked || !a.cli || !mode) return;
    if (a.cli.snapshot()[a.config.provider].meta.mode !== mode) a.cli.setMode(a.config.provider, mode);
  }

  function implement(a, { skipDesign = false } = {}) {
    if (!on) throw new Error('Turn on learning mode first.');
    if (!a.cli) throw new Error('Only Claude and Codex chats can implement changes.');
    const provider = a.config.provider;
    if (a.cli.snapshot()[provider].meta.busy) throw new Error('Wait for the agent to finish its current reply.');
    const cp = beginImplement(cpOf(a), { skipDesign: skipDesign === true });
    a.unlocked = true; a.sawBusy = false;
    a.cli.setMode(provider, 'edit');
    a.cli.send(provider, IMPLEMENT_TEXT + (cp.skipped ? SKIPPED_TEXT : ''));
    announce(a);
  }

  /** The assistant's last finished message after the Approve & implement turn began: the agent's own report. */
  function reportOf(a) {
    const events = a.cli.snapshot()[a.config.provider].events;
    const start = events.map((e) => e.k === 'user' && /^Approved in Tandem/.test(e.text || '')).lastIndexOf(true);
    const msgs = events.slice(start + 1).filter((e) => e.k === 'msg' && e.role === 'assistant' && e.done && e.text);
    return msgs.at(-1)?.text || '';
  }

  /** The approved step is over: the agent locks again, and the step goes into the journal. */
  function finishStep(a) {
    const cp = cpOf(a);
    if (cp.stage !== 'implement') return;
    finishImplement(cp);
    const report = reportOf(a);
    if (report || cp.files.length) {
      try {
        appendEntry(ctx.workingDir, { at: Date.now(), title: cp.request, request: cp.request, design: cp.design, skipped: cp.skipped, choices: cp.choices, files: cp.files, report });
      } catch (e) { console.error('Could not write the learning journal:', e.message); }
    }
    announce(a);
  }

  /** What the main agent's CLI wrapper reports: tracks when an approved turn starts and ends. */
  function onCliMessage(a, msg) {
    if (msg.t !== 'meta') return;
    if (msg.meta?.busy) a.sawBusy = true;
    else if (a.unlocked && a.sawBusy) { a.unlocked = false; a.sawBusy = false; finishStep(a); }
    if (msg.meta && !msg.meta.busy) relock(a);
  }

  return {
    get profile() { return profile; },
    get enabled() { return on; },
    stack: detectedStack,
    STAGES,
    observeEdit,
    onAgentEvent,
    onCliMessage,
    onApproved,
    confirmDesign,
    implement,
    relock,

    /** Learning mode keeps main agents read-only, so the CLI is told to refuse leaving plan mode. */
    denyTool(a, name) {
      return on && !a.unlocked && name === 'ExitPlanMode' ? 'Tandem learning mode: the user must press "Approve & implement" before you leave read-only mode.' : null;
    },
    guardMode(a, mode) {
      if (on && a.cli && !a.unlocked && mode !== READ_ONLY[a.config.provider]) throw new Error('Learning mode keeps this agent read-only until you press Approve & implement.');
    },
    guardDelegation(a) {
      if (on && a?.cli && !a.unlocked) throw new Error('Learning mode: the user must press Approve & implement before this agent delegates work.');
    },
    onSend(a, text) {
      observeLearning(text);
      if (!on || !a.cli) return;
      onUserMessage(cpOf(a), text);
      announce(a);
      if (!a.unlocked) relock(a);
    },
    /** A fresh conversation starts a fresh cycle. */
    reset(a) { a.cp = freshCheckpoint(); if (on && a.cli) announce(a); },

    /** Extra prompt text for a main agent: the profile, the working method and the journal. Nothing when learning mode is off. */
    promptBlocks(provider) {
      if (!on) return [];
      const stack = detectedStack();
      const lines = [
        profile.familiar && `Familiar stack: ${profile.familiar}`,
        profile.learning && `Learning goals: ${profile.learning}`,
        stack.length && `Repo stack (detected from the repository): ${stack.join(', ')}`,
        profile.known.length && `Works with often (by how frequently it comes up): ${profile.known.map((k) => `${k.name} (${k.n})`).join(', ')}`,
        `Experience: ${profile.level}; teaching preference: ${profile.style}; checkpoint frequency: ${profile.checkpoints}.`,
      ].filter(Boolean).join('\n');
      return [`[Learner profile]\n${lines}`, workflowPrompt(provider, profile.checkpoints, { level: profile.level, style: profile.style }), journalPrompt(ctx.workingDir)].filter(Boolean);
    },

    checkpoints: () => Object.fromEntries([...entries.values()].filter((a) => a.cli).map((a) => [a.config.id, publicView(cpOf(a))])),
    journal: () => readEntries(ctx.workingDir).map(({ at, title, fields }) => ({ at, title, fields })),
    clearJournal: () => clearJournal(ctx.workingDir),

    setEnabled(next) {
      on = next === true;
      for (const a of entries.values()) {
        a.cp = freshCheckpoint();
        if (!on) a.unlocked = false; else relock(a);
        if (a.cli) announce(a);
      }
    },
    saveProfile(input) {
      if (!input || typeof input !== 'object') throw new Error('Invalid learner profile.');
      profile = {
        familiar: String(input.familiar || '').slice(0, 2000), learning: String(input.learning || '').slice(0, 2000),
        counts: profile.counts, observed: [], known: [], // the tally is the server's own; only what the user types is taken from the client
        level: LEVELS.includes(input.level) ? input.level : 'familiar', style: STYLES.includes(input.style) ? input.style : 'plain', checkpoints: PACES.includes(input.checkpoints) ? input.checkpoints : 'normal',
      };
      refreshKnown();
    },
    /** What gets saved to workspace.json. */
    state: () => ({ learnerProfile: profile, learningMode: on }),
  };
}
