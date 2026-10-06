// The link to the local server: connection status, messages arriving, the git state, and demo mode
// (a scripted session that uses no quota).

import { createDemo } from '../demo.js';
import { createNet } from '../net.js';
import { $ } from './state.js';

export function initConnection(app) {
  const { AGENTS, NAMES, panels, awaiting, ui, MODEL_PRESETS, CHILD_MODEL_DEFAULTS, configs } = app;

  function setConn(kind, text) {
    const c = $('#conn');
    c.className = 'conn ' + kind;
    $('em', c).textContent = text;
  }
  app.setConn = setConn;
  function setOffline(off) {
    for (const a of AGENTS) panels[a].setOffline(off && !ui.demo);
    app.updateLabels();
  }

  app.setGit = function setGit(git) {
    if (!git) return;
    if (app.repoPath && git.cwd && app.repoPath !== git.cwd) {
      app.localTools?.repoChanged();
      for (const id of AGENTS) { panels[id].ta.value = ''; panels[id].clearAttachments(); panels[id].autosize(); sessionStorage.removeItem(`tandem:draft:${id}`); }
    }
    $('#sl-repo').textContent = git.repo || 'codebase';
    $('#sl-git').textContent = git.branch ? `${git.branch} · ${git.changed ? git.changed + ' changed' : 'clean'}` : 'the codebase';
    $('#cwd').textContent = git.repo ? `…\\${git.repo}` : '';
    app.repoPath = git.cwd || app.repoPath;
    $('#cwd').title = app.repoPath;
    $('#repo-path').value = app.repoPath;
    app.info.setGit(git);
    app.measure();
  };

  app.net = createNet({
    onStatus(kind, data) {
      const { info } = app;
      if (kind === 'session') {
        if (!localStorage.getItem('tandem:setup-complete')) setTimeout(() => { if (!document.querySelector('dialog[open]')) $('#setup-dialog').showModal(); }, 250);
        app.setGit(data.git);
        if (data.local) app.localTools?.receive({ t: 'localstate', ...data.local });
        if (data.local?.childModelDefaults) { Object.assign(CHILD_MODEL_DEFAULTS, data.local.childModelDefaults); app.childChats?.setDefaults(); }
        app.cloneParent = data.cloneParent || '';
        if (data.clone) app.setCloneStatus(data.clone);
        app.reconcile(data.agents);
        for (const [provider, models] of Object.entries(data.models || {})) {
          MODEL_PRESETS[provider] = models;
          for (const id of AGENTS) if (configs[id]?.provider === provider) panels[id].setModels(models);
        }
      } else if (kind === 'open') {
        ui.connected = true;
        setConn('ok', 'live · localhost');
        setOffline(false);
        app.childChats?.setOffline(false);
        info.log({ agent: 'claude', kind: 'info', text: 'connected to the Tandem server' });
        app.terminal?.reconnected();
      } else if (kind === 'closed') {
        app.githubReset();
        ui.connected = false;
        setConn('bad', ui.demo ? 'demo' : 'offline');
        setOffline(true);
        app.childChats?.setOffline(true);
      }
    },
    onMessage(msg) {
      if (ui.demo) return;
      const { info, scene } = app;
      if (app.chatHistory.receive(msg)) return;
      if (app.childChats?.receive(msg)) return;
      if (app.folderPicker?.receive(msg)) return;
      if (app.localTools?.receive(msg)) return;
      if (app.pushDialog?.receive(msg)) return;
      if (app.journal?.receive(msg)) return;
      if (app.terminal?.receive(msg)) return;
      if (msg.t === 'notice') { app.showNotice(msg.text); return; }
      if (msg.t === 'checkpoint') { app.setCheckpoint(msg.agent, msg.checkpoint); return; }
      if (msg.t === 'githubrepos') { app.receiveGithubRepos(msg); return; }
      if (msg.t === 'apimodels') { app.receiveApiModels(msg); return; }
      if (msg.t === 'clone') { app.setCloneStatus(msg); return; }
      if (msg.t === 'snapshot') {
        if (msg.configs) app.reconcile(msg.configs);
        app.childChats?.replace(msg.children || []);
        if (!(msg.clone?.busy ?? app.isCloning())) $('#workspace-dialog').close();
        if (msg.clone) app.setCloneStatus(msg.clone);
        info.clearLog();
        app.resetToolLog();
        for (const a of AGENTS) {
          const snap = msg.agents[a];
          if (!snap) continue;
          awaiting[a].clear();
          for (const ev of snap.events) if (ev.k === 'tool' && ev.status === 'awaiting') awaiting[a].add(ev.id);
          panels[a].reset(snap.events);
          for (const ev of snap.events) if (ev.k === 'tool') app.logTool(a, panels[a].entries.get(ev.id)?.data || ev, true);
          app.onMeta(a, snap.meta);
        }
        app.setGit(msg.git);
      } else if (msg.t === 'ev') app.onEvent(msg.agent, msg.ev);
      else if (msg.t === 'meta') app.onMeta(msg.agent, msg.meta);
      else if (msg.t === 'fx') {
        scene.fx(msg.agent, msg.name);
        if (msg.name === 'compact') info.log({ agent: msg.agent, kind: 'warn', text: 'context compacted' });
      } else if (msg.t === 'reset') {
        awaiting[msg.agent].clear();
        panels[msg.agent].reset(msg.events);
        app.onMeta(msg.agent, msg.meta);
      } else if (msg.t === 'git') app.setGit(msg.git);
    },
  });

  // ---------------------------------------------------------------- demo
  app.setDemo = function setDemo(on) {
    if (on === ui.demo) return;
    const { scene, info, childChats } = app;
    if (on && (AGENTS.length !== 2 || AGENTS.some((a) => !['claude', 'codex'].includes(a)))) { app.showNotice('Demo is available with the original Claude and Codex planets.'); return; }
    ui.demo = on;
    childChats.close();
    childChats.replace(on ? [{ id: 'demo-child', parentId: 'codex', provider: 'claude', title: 'Review the settings change', updatedAt: Date.now(),
      source: 'tandem', meta: { available: true, busy: false, status: 'completed', mode: 'plan', resumable: true, model: 'sonnet' },
      events: [{ k: 'user', id: 'demo-child-task', text: 'Review the settings change and check that saved preferences survive a reload.' },
        { k: 'tool', id: 'demo-child-tool', name: 'Read', summary: 'src/settings.js', status: 'done', output: 'Reviewed the settings hook and local storage fallback.' },
        { k: 'msg', id: 'demo-child-reply', text: 'The theme preference is saved correctly. One case needs attention: when local storage is unavailable, the settings hook should fall back to the default theme.\n\nI sent the finding back to the main task.', done: true }] }] : []);
    $('#btn-demo').classList.toggle('on', on);
    if (on) {
      info.clearLog();
      app.resetToolLog();
      for (const a of AGENTS) {
        awaiting[a].clear();
        panels[a].reset([]);
        panels[a].setOffline(false);
        app.onMeta(a, { available: true, busy: false, awaiting: 0 });
      }
      setConn('', 'demo · no quota used');
      app.demo = createDemo({
        handle: (agent, ev) => app.onEvent(agent, ev),
        setMeta: (agent, meta) => app.onMeta(agent, meta),
        fx: (agent, name) => scene.fx(agent, name),
        log: (e) => info.log(e),
      });
      app.demo.run();
    } else {
      app.demo?.stop();
      info.clearLog();
      for (const a of AGENTS) {
        panels[a].reset([]);
        awaiting[a].clear();
        app.onMeta(a, { busy: false, awaiting: 0, stats: undefined });
      }
      if (ui.connected) {
        setConn('ok', 'live · localhost');
        app.net.send({ t: 'sync' });
      } else setConn('bad', 'offline');
      setOffline(!ui.connected);
    }
  };
}
