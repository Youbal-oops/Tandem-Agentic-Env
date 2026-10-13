// Fixed settings shared by the Claude and Codex adapters.

export const MAX_EVENTS = 1500; // events kept per chat before the oldest are dropped
export const MAX_OUT = 6000; // characters of tool output kept per tool call

export const MODES = {
  claude: [
    { id: 'ask', label: 'Ask', hint: 'Asks before running anything that changes things' },
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files freely, asks before other actions' },
    { id: 'auto', label: 'Auto', hint: 'Claude approves low-risk actions on its own' },
  ],
  codex: [
    { id: 'read', label: 'Read-only', hint: 'Can look around, cannot change files' },
    { id: 'edit', label: 'Edit', hint: 'Can edit files in this folder, sandboxed' },
    { id: 'full', label: 'Full access', hint: 'No sandbox: its shell can use the internet and reach anything on this computer. Needs switching on in Settings.' },
  ],
  gemini: [
    { id: 'plan', label: 'Plan', hint: 'Read-only: explores and proposes, changes nothing' },
    { id: 'edit', label: 'Edit', hint: 'Edits files freely, asks before other actions' },
    { id: 'full', label: 'Full access', hint: 'Approves every action itself, including shell commands. Needs switching on in Settings.' },
  ],
};
export const GEMINI_APPROVAL = { plan: 'plan', edit: 'auto_edit', full: 'yolo' };
/** Modes that remove the safety net; the user must allow them in Settings first. */
export const UNSAFE_MODES = new Set(['full']);
export const CLAUDE_MODE_FLAG = { ask: 'default', plan: 'plan', edit: 'acceptEdits', auto: 'auto' };
export const CODEX_SANDBOX = { read: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Model names are passed to the CLIs as arguments, so only plain identifiers are accepted. */
export const validModel = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,79}$/.test(s);
