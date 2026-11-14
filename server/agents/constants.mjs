// Fixed settings shared by the Claude and Codex adapters.

export const MAX_EVENTS = 1500; // events kept per chat before the oldest are dropped
export const MAX_OUT = 6000; // characters of tool output kept per tool call

export const MODES = {
  claude: [
    { id: 'ask', label: 'Ask', hint: 'Asks before running anything that changes things' },
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files freely, asks before other actions' },
    { id: 'auto', label: 'Auto', hint: 'Claude approves low-risk actions on its own' },
    { id: 'full', label: 'Full access', hint: 'Runs every command and edit without asking. Not sandboxed: it can reach anything on this computer you can. Needs your permission in Settings.' },
  ],
  codex: [
    { id: 'read', label: 'Read-only', hint: 'Can look around, cannot change files' },
    { id: 'edit', label: 'Edit', hint: 'Sandboxed: can change files and run commands in its own folder, with network access, and nothing outside it' },
    { id: 'full', label: 'Full access', hint: 'No sandbox: its commands can use the internet and reach anything on this computer you can. Needs your permission in Settings.' },
  ],
  gemini: [
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files freely, asks before other actions' },
    { id: 'full', label: 'Full access', hint: 'Runs every command and edit without asking. Not sandboxed: it can reach anything on this computer you can. Needs your permission in Settings.' },
  ],
  antigravity: [
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files. Commands are refused: Antigravity has no working sandbox, so running them is Full access' },
    { id: 'auto', label: 'Auto', hint: 'Antigravity decides which actions are safe to run on its own; anything it would ask about is refused' },
    { id: 'full', label: 'Full access', hint: 'Runs every command and edit without asking. Not sandboxed: it can reach anything on this computer you can. Needs your permission in Settings.' },
  ],
};
/** Antigravity CLI flags per mode: `--mode`, and whether permission prompts are skipped altogether. */
// Headless Antigravity cannot ask for permission, and its own --sandbox blocks all writes and network, so it is not used.
// Running commands is therefore Full access only, which the user has to permit (see UNSAFE_MODES).
export const ANTIGRAVITY_MODE = { plan: { mode: 'plan' }, edit: { mode: 'accept-edits' }, auto: { mode: 'auto' }, full: { mode: 'auto', skip: true } };
export const GEMINI_APPROVAL = { plan: 'plan', edit: 'auto_edit', full: 'yolo' };
/** Modes that remove the safety net; the user must allow them in Settings first. */
export const UNSAFE_MODES = new Set(['full']);
export const CLAUDE_MODE_FLAG = { ask: 'default', plan: 'plan', edit: 'acceptEdits', auto: 'auto', full: 'bypassPermissions' };
export const CODEX_SANDBOX = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Model names are passed to the CLIs as arguments, so only plain identifiers are accepted. */
export const validModel = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(s);
