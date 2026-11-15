// Tandem's browser UI. This file only boots it: it creates the shared `app` object, then starts each part in ./app/
// (every part registers its functions on `app`, see app/state.js). The UI is text first: the 3D planet view and the
// code editor are separate chunks that are only downloaded when they are opened.

import './style.css';

import { createChatHistory } from './history.js';
import { createChildChats } from './children.js';
import { createCodeView } from './code.js';
import { createVscodePanel } from './vscode.js';
import { createTeamChat } from './team.js';
import { createReviewPanel } from './reviewpanel.js';
import { createFolderPicker } from './folders.js';
import { InfoPanel } from './info.js';
import { createLocalTools } from './local.js';
import { createJournalDialog } from './journal.js';
import { createSettingsDialog } from './settings.js';
import { createConnectDialog } from './connect.js';
import { createSetup } from './setup.js';
import { createStructurePanel } from './structure.js';
import { createPushDialog } from './push.js';
import { initAgents } from './app/agents.js';
import { initConnection } from './app/connection.js';
import { initControls } from './app/controls.js';
import { initLayout } from './app/layout.js';
import { initMenus } from './app/menus.js';
import { initNotice } from './app/notice.js';
import { initPlanets } from './app/planets.js';
import { initWorkspace } from './app/workspace.js';
import { $, createApp } from './app/state.js';

const app = createApp();
const params = new URLSearchParams(location.search);

// Until the planet view is opened there is no scene: every call to it does nothing (see app/planets.js).
app.scene = new Proxy({}, { get: () => () => {} });

initNotice(app);
const connected = () => app.net.open && !app.ui.demo;
const source = () => app.ui.sel || 'repo';
/** Add text to an agent's message box, after whatever is already there. */
function setDraft(id, text) {
  const panel = app.panels[id];
  if (!panel) return false;
  const draft = [panel.ta.value, text].filter(Boolean).join('\n\n');
  if (draft.length > 40000) { app.showNotice('The combined draft exceeds 40,000 characters. Shorten it first.'); return false; }
  app.select(id); panel.setDraft(draft); return true;
}

initLayout(app);
initPlanets(app);
app.info = new InfoPanel($('#right'), { onSelect: (id) => app.select(id) });
app.chatHistory = createChatHistory({ send: (msg) => app.net?.send(msg), connected: () => !!app.net?.open && !app.ui.demo, getRepo: () => app.repoPath, getName: (id) => app.NAMES[id], notify: (text) => app.showNotice(text) });
app.code = createCodeView({ send: (msg) => app.net.send(msg), connected, notify: (text) => app.showNotice(text), getRepo: () => app.repoPath, getSelected: () => app.ui.sel, setDraft, isOpen: () => app.sideView() === 'code',
  onOpenFile: () => { if (app.sideView() !== 'code') app.side('code'); }, onSource: (src) => app.vscode?.setSource(src) });
app.onSide((view) => { if (view === 'code') app.code.shown(); });
app.review = createReviewPanel({ send: (msg) => app.net.send(msg), connected, isOpen: () => app.sideView() === 'review', show: () => app.side('review'),
  getColor: (id) => app.panels[id]?.row.style.getPropertyValue('--c'), openInCode: (agent, path) => { app.side('code'); app.code.open(agent, path); } });
app.onSide((view) => { if (view === 'review') app.review.shown(); });
app.team = createTeamChat(app);
app.vscode = createVscodePanel({ send: (msg) => app.net.send(msg), connected, getSelected: () => app.ui.sel, isOpen: () => app.sideView() === 'vscode' });
app.onSide((view) => { if (view === 'vscode') app.vscode.shown(); });
initAgents(app);
app.childChats = createChildChats({ panels: app.panels, send: (m) => app.net?.send(m), selectParent: (id) => app.select(id), notice: (text) => app.showNotice(text), isDemo: () => app.ui.demo, models: () => app.MODEL_PRESETS, defaults: () => app.CHILD_MODEL_DEFAULTS, onChange: app.childActivity });
initConnection(app);
initWorkspace(app);
initControls(app);
initMenus(app);

app.pushDialog = createPushDialog({ send: (msg) => app.net.send(msg), connected, getSource: source, notify: app.showNotice });
app.journal = createJournalDialog({ send: (msg) => app.net.send(msg), connected, notify: app.showNotice });
app.folderPicker = createFolderPicker({ send: (msg) => app.net.send(msg), connected, getRepo: () => app.repoPath, notify: app.showNotice });
app.settingsDialog = createSettingsDialog({ send: (msg) => app.net.send(msg), connected, notify: app.showNotice, openReview: () => app.side('review'),
  getAgents: () => app.AGENTS.map((id) => ({ id, name: app.NAMES[id] })), defaultGuide: () => app.teamGuide || '', defaultCoordinatorGuide: () => app.coordinatorGuide || '' });
app.setup = createSetup({ send: (msg) => app.net.send(msg), connected });
app.connectDialog = createConnectDialog({ send: (msg) => app.net.send(msg), connected, notify: app.showNotice });
app.structurePanel = createStructurePanel({ send: (msg) => app.net.send(msg), connected, notify: app.showNotice, getAgents: () => app.AGENTS.map((id) => ({ id, name: app.NAMES[id] })), setDraft });
app.localTools = createLocalTools({
  onSettings: (settings) => app.settingsDialog.local(settings),
  send: (msg) => app.net.send(msg), connected, getRepo: () => app.repoPath, notify: app.showNotice,
  onLearning: (on) => app.setLearning(on),
  onTodoMode: (on) => app.setTodoMode(on),
  onCheckpoints: (map) => { for (const [agent, cp] of Object.entries(map || {})) app.setCheckpoint(agent, cp); },
});

app.restoreLayout();
if (['review', 'code', 'vscode', 'activity', 'planets'].includes(params.get('side'))) app.side(params.get('side'));
app.select(null);
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('boot')));
app.setConn('', 'connecting');
if (params.has('demo')) app.setDemo(true);
app.net.connect();
const startSel = params.get('sel');
if (startSel && app.AGENTS.includes(startSel)) app.select(startSel);
