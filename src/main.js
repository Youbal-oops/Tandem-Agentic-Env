// Tandem's browser UI. This file only boots it: it creates the 3D scene and the shared `app` object, then
// starts each part in ./app/ (every part registers its functions on `app`, see app/state.js).

import '@fontsource/playfair-display/400-italic.css';
import '@fontsource/inter/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';
import './workspace.css';
import './styles/features.css';

import { createChatHistory } from './history.js';
import { createChildChats } from './children.js';
import { createFolderPicker } from './folders.js';
import { InfoPanel } from './info.js';
import { createLocalTools } from './local.js';
import { createJournalDialog } from './journal.js';
import { createPushDialog } from './push.js';
import { createTerminalPanel } from './terminal.js';
import { initAgents } from './app/agents.js';
import { initBoard } from './app/board.js';
import { initConnection } from './app/connection.js';
import { initControls } from './app/controls.js';
import { initLabels } from './app/labels.js';
import { initLayout } from './app/layout.js';
import { initNotice } from './app/notice.js';
import { initWorkspace } from './app/workspace.js';
import { $, createApp } from './app/state.js';

const app = createApp();

// Lite mode: text only, no 3D scene (see scene-lite.js). ?lite=0 / ?lite=1 override the saved choice.
const params = new URLSearchParams(location.search);
if (params.get('lite') !== null) localStorage.setItem('tandem:lite', params.get('lite') !== '0');
app.lite = localStorage.getItem('tandem:lite') === 'true';
document.body.classList.toggle('lite', app.lite);
if (params.get('theme') === 'space' || params.get('theme') === 'forest') localStorage.setItem('tandem:theme', params.get('theme'));
app.theme = localStorage.getItem('tandem:theme') === 'forest' ? 'forest' : 'space';
document.body.dataset.theme = app.theme;
const { createScene } = await (app.lite ? import('./scene-lite.js') : app.theme === 'forest' ? import('./scene-forest.js') : import('./scene.js'));
app.scene = createScene($('#stage'));

initNotice(app);
const connected = () => app.net.open && !app.ui.demo;
const source = () => app.ui.sel || 'repo';

app.info = new InfoPanel($('#right'), { onSelect: (id) => app.select(id) });
app.chatHistory = createChatHistory({ send: (msg) => app.net?.send(msg), connected: () => !!app.net?.open && !app.ui.demo, getRepo: () => app.repoPath, getName: (id) => app.NAMES[id], notify: (text) => app.showNotice(text) });
initBoard(app);
initAgents(app);
app.childChats = createChildChats({ panels: app.panels, send: (m) => app.net?.send(m), selectParent: (id) => app.select(id), notice: (text) => app.showNotice(text), isDemo: () => app.ui.demo, models: () => app.MODEL_PRESETS, defaults: () => app.CHILD_MODEL_DEFAULTS, onChange: app.childActivity });
initLayout(app);
initLabels(app);
initConnection(app);
initWorkspace(app);
initControls(app);

app.pushDialog = createPushDialog({ send: (msg) => app.net.send(msg), connected, getSource: source, notify: app.showNotice });
app.terminal = createTerminalPanel({ send: (msg) => app.net.send(msg), connected, getSource: source, notify: app.showNotice });
app.journal = createJournalDialog({ send: (msg) => app.net.send(msg), connected, notify: app.showNotice });
app.folderPicker = createFolderPicker({ send: (msg) => app.net.send(msg), connected, getRepo: () => app.repoPath, notify: app.showNotice });
app.localTools = createLocalTools({
  send: (msg) => app.net.send(msg), connected, getRepo: () => app.repoPath,
  getAgents: () => app.AGENTS.map((id) => ({ id, name: app.NAMES[id] })), notify: app.showNotice,
  onLearning: (on) => app.setLearning(on),
  onCheckpoints: (map) => { for (const [agent, cp] of Object.entries(map || {})) app.setCheckpoint(agent, cp); },
  setDraft(id, text) {
    const panel = app.panels[id];
    if (!panel) return false;
    const draft = [panel.ta.value, text].filter(Boolean).join('\n\n');
    if (draft.length > 40000) { app.showNotice('The combined draft exceeds 40,000 characters. Shorten it first.'); return false; }
    panel.setDraft(draft); app.select(id); return true;
  },
});

app.layout();
app.scene.setTopDown(true);
app.select(null);
app.updateLabels();
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('boot')));
document.fonts?.ready.then(app.updateLabels);
app.setConn('', 'connecting');
if (params.has('demo')) app.setDemo(true);
app.net.connect();
const startSel = params.get('sel');
if (startSel && app.AGENTS.includes(startSel)) app.select(startSel);
if (params.has('sky')) setTimeout(app.playSky, 1500);
