// The sidebar buttons and the keyboard: the side panel views, the terminal, editor and browser buttons, demo, and the shortcuts.

import { $ } from './state.js';

export function initControls(app) {
  const { ui } = app;

  $('#btn-rail').addEventListener('click', () => app.setRail(!app.railHidden()));
  $('#btn-code').addEventListener('click', () => app.toggleSide('code'));
  $('#btn-review').addEventListener('click', () => app.toggleSide('review'));
  $('#btn-activity').addEventListener('click', () => app.toggleSide('activity'));
  $('#btn-planets').addEventListener('click', () => app.toggleSide('planets'));
  $('#side-close').addEventListener('click', () => app.side(null));
  $('#btn-demo').addEventListener('click', () => app.setDemo(!ui.demo));

  // The terminal opens as its own window, in the selected agent's worktree or else the repository. (VS Code is a side panel, see ../vscode.js.)
  const openTool = (t) => (app.net.open ? app.net.send({ t, source: ui.sel || 'repo' }) : app.showNotice('Connect to the server first.'));
  // The terminal is VS Code's own, inside the VS Code panel. Until the embedded editor has been agreed to, it opens as a window.
  const terminal = () => { if (!app.vscode?.agreed()) return openTool('open-terminal'); app.side('vscode'); app.vscode.terminal(); };
  $('#btn-terminal').addEventListener('click', terminal);
  $('#btn-editor').addEventListener('click', () => app.toggleSide('vscode'));
  // Each agent has its own browser window; this brings the selected agent's forward.
  $('#btn-browser').addEventListener('click', () => {
    if (!ui.sel) return app.showNotice('Add an agent first: each agent has its own browser window.');
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    app.net.send({ t: 'show-browser', source: ui.sel });
  });

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || !!document.activeElement?.closest?.('.cm-editor');
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.key === '`' || e.code === 'Backquote') { e.preventDefault(); terminal(); return; }
      if (e.key === '\\' || e.code === 'Backslash') { e.preventDefault(); app.setRail(!app.railHidden()); return; }
      const k = e.key.toLowerCase();
      if (k === 'b' && !document.querySelector('dialog[open]')) { e.preventDefault(); app.toggleSide('code'); return; }
      if (k === 'r' && !typing() && !document.querySelector('dialog[open]')) { e.preventDefault(); app.toggleSide('review'); return; }
      if (k === 'e' && !typing()) { e.preventDefault(); app.toggleSide('vscode'); return; }
    }
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const actions = { ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, () => { if (app.AGENTS[n - 1]) { app.team?.hide(); app.select(app.AGENTS[n - 1]); } }])), 0: () => app.team?.show(), d: () => app.setDemo(!ui.demo) };
    if (actions[k]) {
      e.preventDefault();
      actions[k]();
    }
  });
}
