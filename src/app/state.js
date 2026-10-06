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
  ],
  codex: [
    { id: 'read', label: 'Read-only', hint: 'Can look around, cannot change files' },
    { id: 'edit', label: 'Edit', hint: 'Can edit files in this folder, sandboxed' },
  ],
};

export function createApp() {
  return {
    AGENTS: ['claude', 'codex'],
    NAMES: { claude: 'Claude', codex: 'Codex' },
    CODES: { claude: 'CLD', codex: 'CDX' },
    MODES,
    // Claude accepts these aliases; Codex model names change often, so it offers its default plus a custom name.
    MODEL_PRESETS: { claude: ['opus', 'sonnet', 'haiku'], codex: [] },
    CHILD_MODEL_DEFAULTS: {},
    configs: {},
    panels: {},
    act: {}, // per-agent activity: chars, rate, spark, tps
    warned: {}, // which context/limit warnings were already logged
    awaiting: { claude: new Set(), codex: new Set() },
    ui: { sel: null, hidden: false, demo: false, connected: false, learning: false, checkpoints: {} },
    bootAt: Date.now(),
    repoPath: '',
    cloneParent: '',
    // Created by main.js and the modules, in this order:
    scene: null, info: null, net: null, demo: null, localTools: null, folderPicker: null, childChats: null, chatHistory: null, pushDialog: null, terminal: null,
    theme: 'space', lite: false,
  };
}
