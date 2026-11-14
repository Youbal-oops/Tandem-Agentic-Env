// The one object the app modules share. Modules read what they need from it and add what they provide:
// stable collections (panels, configs, ...) are plain properties, and each module registers its public
// functions on it (app.select, app.onMeta ...) so modules can call each other without importing each other.

export const $ = (s, r = document) => r.querySelector(s);
export const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

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

export function createApp() {
  return {
    AGENTS: [], // a workspace starts with no agents; they are added as the user connects them
    NAMES: {},
    CODES: {},
    MODES,
    // Claude accepts these aliases; Codex model names change often, so it offers its default plus a custom name.
    MODEL_PRESETS: { claude: ['opus', 'sonnet', 'haiku'], codex: [], gemini: [], antigravity: [] },
    CHILD_MODEL_DEFAULTS: {},
    configs: {},
    panels: {},
    act: {}, // per-agent activity: chars, rate, spark, tps
    warned: {}, // which context/limit warnings were already logged
    awaiting: {},
    ui: { sel: null, hidden: false, demo: false, connected: false, learning: false, todoMode: false, todos: {}, checkpoints: {} },
    bootAt: Date.now(),
    repoPath: '',
    cloneParent: '',
    // Created by main.js and the modules, in this order:
    scene: null, info: null, net: null, demo: null, localTools: null, folderPicker: null, childChats: null, chatHistory: null, pushDialog: null,
    lite: false,
  };
}
