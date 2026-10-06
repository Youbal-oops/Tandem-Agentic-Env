// The Workspace and Set up dialogs: opening a folder, cloning (from a link or your GitHub account),
// adding and removing planets, the first-run setup, and exporting the conversations.

import { AGENT_LOOK } from '../looks.js';
import { $ } from './state.js';

export function initWorkspace(app) {
  const { AGENTS, NAMES, configs, panels, ui } = app;
  let cloneBusy = false;
  let githubRepos = [];
  let githubPage = 0;
  let githubLoading = false;
  app.isCloning = () => cloneBusy;

  function openWorkspace() {
    if (ui.demo) { app.showNotice('Leave demo mode to change the workspace.'); return; }
    $('#repo-path').value = app.repoPath;
    renderAgentList();
    app.localTools.openWorkspace();
    $('#workspace-dialog').showModal();
  }
  app.openWorkspace = openWorkspace;
  function openWorkspaceTab(tab) {
    openWorkspace();
    document.querySelector(`[data-workspace-tab="${tab}"]`)?.click();
  }

  app.setCloneStatus = function setCloneStatus(state) {
    cloneBusy = !!state.busy;
    $('#clone-status').textContent = state.text || '';
    $('#clone-status').classList.toggle('clone-error', state.ok === false);
    document.querySelectorAll('#clone-submit, #repo-form button, #clone-source, #clone-url, #clone-destination').forEach((el) => { el.disabled = cloneBusy; });
    $('#clone-submit').textContent = cloneBusy ? 'Cloning…' : 'Clone and open';
    for (const id of AGENTS) panels[id].setWorkspaceBusy(cloneBusy);
    $('#agent-form button[type="submit"]').disabled = cloneBusy;
    renderGithubRepos();
    if (state.ok) app.showNotice(state.text);
    if (state.ok === false && !$('#workspace-dialog').open) app.showNotice(state.text);
  };

  function suggestCloneDestination() {
    const input = $('#clone-destination');
    if (input.value && input.value !== input.dataset.suggested) return;
    const raw = $('#clone-url').value.trim().replace(/\/$/, '').split('/').at(-1)?.replace(/\.git$/, '');
    if (!raw || !/^[A-Za-z0-9_.-]+$/.test(raw) || !app.cloneParent) return;
    const separator = app.cloneParent.includes('\\') ? '\\' : '/';
    input.value = app.cloneParent.replace(/[\\/]+$/, '') + separator + raw;
    input.dataset.suggested = input.value;
  }
  function loadGithubRepos(page = 1) {
    if (!app.net.open) return app.showNotice('Connect to the Tandem server first.');
    if (githubLoading) return;
    githubLoading = true;
    $('#github-account').textContent = 'Loading…';
    $('#load-github-repos').disabled = $('#more-github-repos').disabled = true;
    app.net.send({ t: 'githubrepos', page });
  }
  app.receiveGithubRepos = function receiveGithubRepos(msg) {
    githubLoading = false;
    $('#load-github-repos').disabled = $('#more-github-repos').disabled = false;
    if (msg.error) { $('#github-account').textContent = msg.error; return; }
    githubPage = msg.page;
    githubRepos = msg.page === 1 ? msg.repos : [...githubRepos, ...msg.repos];
    $('#github-account').textContent = `Signed in as ${msg.login}`;
    $('#more-github-repos').hidden = !msg.hasMore;
    renderGithubRepos();
  };
  /** The connection dropped: nothing is loading any more. */
  app.githubReset = () => { githubLoading = false; $('#load-github-repos').disabled = $('#more-github-repos').disabled = false; };

  function renderGithubRepos() {
    const query = $('#github-search').value.trim().toLowerCase();
    const list = $('#github-repos'); list.replaceChildren();
    const rows = githubRepos.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(query));
    for (const repo of rows) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'github-repo';
      const title = document.createElement('b'); title.textContent = repo.name;
      const visibility = document.createElement('span'); visibility.textContent = `${repo.private ? 'Private' : 'Public'}${repo.archived ? ' · archived' : ''}`;
      const description = document.createElement('small'); description.textContent = repo.description;
      button.append(title, visibility, description);
      button.classList.toggle('selected', $('#clone-url').value === repo.url);
      button.disabled = cloneBusy;
      button.addEventListener('click', () => { $('#clone-url').value = repo.url; suggestCloneDestination(); renderGithubRepos(); });
      list.append(button);
    }
    if (!rows.length) { const empty = document.createElement('p'); empty.textContent = githubRepos.length ? 'No matching repositories.' : 'No repositories loaded yet.'; list.append(empty); }
  }

  app.renderAgentList = function renderAgentList() {
    const list = $('#agent-list'); list.replaceChildren();
    for (const id of AGENTS) {
      const row = document.createElement('div'); row.className = 'settings-agent';
      const label = document.createElement('span');
      label.textContent = `${NAMES[id]} · ${configs[id]?.provider || id} · ${panels[id].state[1]}`;
      label.style.color = AGENT_LOOK[id].hex;
      const remove = document.createElement('button'); remove.textContent = 'Remove';
      remove.disabled = AGENTS.length < 2 || !!panels[id].meta.busy;
      remove.addEventListener('click', () => { if (confirm(`Remove ${NAMES[id]} and its conversation? Export first if you need a copy.`)) app.net.send({ t: 'removeagent', agent: id }); });
      row.append(label, remove); list.append(row);
    }
  };
  const renderAgentList = app.renderAgentList;

  // ---------------------------------------------------------------- wiring
  $('#clone-source').addEventListener('change', () => {
    $('#github-browser').hidden = $('#clone-source').value !== 'account';
    if ($('#clone-source').value === 'account' && !githubRepos.length) loadGithubRepos();
  });
  $('#load-github-repos').addEventListener('click', () => loadGithubRepos());
  $('#more-github-repos').addEventListener('click', () => loadGithubRepos(githubPage + 1));
  $('#github-search').addEventListener('input', renderGithubRepos);
  $('#clone-url').addEventListener('input', suggestCloneDestination);
  $('#clone-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    if (cloneBusy) return;
    if (AGENTS.some((id) => panels[id].meta.busy)) { $('#clone-status').textContent = 'Stop running agents before cloning and opening a repository.'; return; }
    app.net.send({ t: 'clone', source: $('#clone-source').value, url: $('#clone-url').value.trim(), destination: $('#clone-destination').value.trim() });
  });
  $('#btn-workspace').addEventListener('click', openWorkspace);
  $('#btn-setup').addEventListener('click', () => $('#setup-dialog').showModal());
  $('#close-setup').addEventListener('click', () => $('#setup-dialog').close());
  $('#finish-setup').addEventListener('click', () => { localStorage.setItem('tandem:setup-complete', '1'); $('#setup-dialog').close(); app.showNotice('Setup saved. You can reopen it anytime from Set up.'); });
  document.querySelectorAll('[data-setup]').forEach((button) => button.addEventListener('click', () => {
    const action = button.dataset.setup;
    $('#setup-dialog').close();
    if (action === 'folder') return openWorkspaceTab('local');
    if (action === 'clone' || action === 'github') {
      openWorkspaceTab('clone');
      if (action === 'github') { $('#clone-source').value = 'account'; $('#clone-source').dispatchEvent(new Event('change')); }
      return;
    }
    if (action === 'agents') return openWorkspaceTab('agents');
    if (action === 'profile') return $('#btn-profile').click();
    app.showNotice('New project setup is the next Tandem step. For now, choose a new empty folder with Open a folder.');
  }));
  $('#close-workspace').addEventListener('click', () => $('#workspace-dialog').close());
  $('.sl').style.pointerEvents = 'auto';
  $('.sl').style.cursor = 'pointer';
  $('.sl').title = 'Change working repository or manage agents';
  $('.sl').addEventListener('click', openWorkspace);
  $('#repo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    app.net.send({ t: 'repo', cwd: $('#repo-path').value.trim() });
  });
  $('#agent-provider').addEventListener('change', () => {
    const api = $('#agent-provider').value === 'api';
    $('#api-fields').hidden = !api;
    $('#agent-form [name="model"]').required = api;
    $('#agent-form [name="endpoint"]').required = api;
  });
  $('#detect-api-models').addEventListener('click', () => {
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    $('#api-model-status').textContent = 'Checking…';
    app.net.send({ t: 'apimodels', endpoint: $('#agent-form [name="endpoint"]').value.trim(), keyEnv: $('#agent-form [name="keyEnv"]').value.trim() });
  });
  app.receiveApiModels = (msg) => {
    const status = $('#api-model-status');
    if (msg.error) { status.textContent = msg.error; return; }
    const list = $('#api-model-options'); list.replaceChildren();
    for (const model of msg.models || []) { const option = document.createElement('option'); option.value = model; list.append(option); }
    status.textContent = `${msg.models.length} model${msg.models.length === 1 ? '' : 's'} found`;
    if (!$('#agent-form [name="model"]').value && msg.models[0]) $('#agent-form [name="model"]').value = msg.models[0];
  };
  $('#agent-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!app.net.open) return app.showNotice('Connect to the server first.');
    app.net.send({ t: 'addagent', config: Object.fromEntries(new FormData(e.target)) });
  });
  $('#btn-export').addEventListener('click', () => {
    const lines = [`# Tandem session`, ``, `Repository: ${app.repoPath}`, `Exported: ${new Date().toISOString()}`, ``];
    for (const id of AGENTS) {
      lines.push(`## ${NAMES[id]}`, `Model: ${panels[id].meta.modelPref || panels[id].meta.model || 'CLI default'} · Effort: ${panels[id].meta.effort || 'default'}`, ``);
      for (const en of panels[id].entries.values()) {
        if (en.el.classList.contains('user')) lines.push(`### You`, en.el.querySelector('.bub').textContent, ...(en.attachments || []).map((a) => `Attached image: ${a.name || 'Image'} (.tandem/uploads/${a.id})`), ``);
        else if (en.el.classList.contains('bot')) lines.push(`### ${NAMES[id]}`, en.text || '', ``);
        else if (en.data) lines.push(`- ${en.data.name}: ${en.data.summary || ''} (${en.data.status})`);
        else if (en.el.classList.contains('err')) lines.push(`Error: ${en.el.textContent}`, ``);
      }
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    const a = document.createElement('a'); a.href = url; a.download = `tandem-${new Date().toISOString().slice(0, 10)}.md`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-workspace-tab]').forEach((b) => { b.classList.toggle('on', b === button); b.setAttribute('aria-pressed', String(b === button)); });
    document.querySelectorAll('[data-workspace-page]').forEach((page) => { page.hidden = page.dataset.workspacePage !== button.dataset.workspaceTab; });
  }));
}
