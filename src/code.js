// The code view in the side panel: a file tree, tabs and an editor, in the spirit of VS Code but small.
// It browses the repository or one agent's own worktree (that is where the agent's edits are), saves edits back
// through the server, and can put a file or a selection into the selected agent's message box.
// The editor itself (editor.js) is only loaded when the first file is opened.

const $ = (s) => document.querySelector(s);
const MAX_DRAFT = 30000;

export function createCodeView({ send, connected, notify, getRepo, getSelected, setDraft, isOpen, onOpenFile = () => {}, onSource = () => {} }) {
  let source = 'repo';
  let agents = [];
  let git = null;
  let listTab = 'files';
  let request = 0;
  let editor = null;
  let editorLoading = null;
  const pending = new Map(); // request id -> what was asked
  const dirs = new Map(); // folder path -> its entries, for the current source
  const expanded = new Set(['']);
  const tabs = []; // { key, source, path, kind: 'file' | 'diff', saved, mtime, dirty }
  let active = null;

  const say = (text, bad = false) => { $('#code-msg').textContent = text || ''; $('#code-msg').classList.toggle('bad', !!bad); };
  const keyOf = (src, path) => `${src}\n${path}`;
  const tabByKey = (key) => tabs.find((tab) => tab.key === key);
  const current = () => tabByKey(active);
  const baseName = (path) => path.split('/').pop();
  function ask(msg, note) {
    if (!connected()) { say('Not connected to Tandem.', true); return false; }
    const id = ++request;
    pending.set(id, note);
    send({ ...msg, request: id });
    return true;
  }

  // ------------------------------------------------------------ the folder being browsed
  function renderSources() {
    const select = $('#code-source');
    select.replaceChildren(Object.assign(document.createElement('option'), { value: 'repo', textContent: 'Repository' }), Object.assign(document.createElement('option'), { value: 'shared', textContent: 'Shared folder (all agents)' }));
    for (const a of agents) select.append(Object.assign(document.createElement('option'), { value: a.id, textContent: `${a.name}'s worktree` }));
    if (![...select.options].some((o) => o.value === source)) source = 'repo';
    select.value = source;
  }
  function setSource(next) {
    source = next;
    dirs.clear(); expanded.clear(); expanded.add('');
    renderSources();
    refresh();
    onSource(source);
  }

  // ------------------------------------------------------------ the file list
  const loadDir = (path) => ask({ t: 'files', source, path }, { kind: 'files', source, path });
  function refresh() {
    if (!connected()) return;
    for (const path of expanded) loadDir(path);
    renderList();
    if (!isOpen()) return;
    const tab = current();
    if (tab?.kind === 'file' && !tab.dirty) readFile(tab.source, tab.path);
    if (tab?.kind === 'diff') readDiff(tab.source);
  }
  // The tree follows the project as agents work: when git reports a change, the open folders are read again (at most every 3 s).
  let lastTreeLoad = 0;
  function reloadTree() { if (!connected() || Date.now() - lastTreeLoad < 3000) return; lastTreeLoad = Date.now(); for (const path of expanded) loadDir(path); }
  function row(label, { depth = 0, cls = '', title = label, onClick, tail }) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `code-row ${cls}`; b.title = title;
    b.style.paddingLeft = `${10 + depth * 14}px`;
    const name = document.createElement('span'); name.className = 'nm'; name.textContent = label;
    b.append(name);
    if (tail) b.append(tail);
    b.addEventListener('click', onClick);
    return b;
  }
  function renderTree(list, path, depth) {
    const entries = dirs.get(path);
    if (!entries) { if (path === '') list.append(Object.assign(document.createElement('p'), { textContent: 'Loading…' })); return; }
    if (!entries.length && path === '') list.append(Object.assign(document.createElement('p'), { textContent: 'This folder is empty.' }));
    for (const e of entries) {
      if (e.directory) {
        const open = expanded.has(e.path);
        list.append(row(e.name, { depth, cls: `dir${open ? ' open' : ''}`, title: e.path, onClick: () => {
          if (open) expanded.delete(e.path); else { expanded.add(e.path); if (!dirs.has(e.path)) loadDir(e.path); }
          renderList();
        } }));
        if (open) renderTree(list, e.path, depth + 1);
      } else {
        const changed = source === 'repo' ? git?.files?.find((f) => f.p === e.path) : null;
        const tail = changed ? Object.assign(document.createElement('span'), { className: `st st-${String(changed.s).trim()[0] || 'M'}`, textContent: changed.s, title: `+${changed.add || 0} −${changed.del || 0}` }) : undefined;
        list.append(row(e.name, { depth, cls: `file${active === keyOf(source, e.path) ? ' on' : ''}${changed ? ' changed' : ''}`, title: e.path, tail, onClick: () => { onOpenFile(); openFile(source, e.path); } }));
      }
    }
  }
  function renderChanges(list) {
    if (source !== 'repo') {
      list.append(Object.assign(document.createElement('p'), { textContent: 'Press Diff to see the uncommitted changes in this worktree, or Review for the agent\'s notes on each change.' }));
      return;
    }
    const files = git?.files || [];
    if (!files.length) list.append(Object.assign(document.createElement('p'), { textContent: git?.branch ? 'No uncommitted changes.' : 'This folder is not a git repository yet.' }));
    for (const f of files) {
      const tail = document.createElement('span'); tail.className = `st st-${String(f.s).trim()[0] || 'M'}`; tail.textContent = f.s;
      list.append(row(baseName(f.p), { cls: `file${active === keyOf('repo', f.p) ? ' on' : ''}`, title: `${f.p}${f.add || f.del ? `  +${f.add} −${f.del}` : ''}`, tail, onClick: () => {
        if (String(f.s).includes('D')) return say(`${f.p} was deleted. Press Diff to see what it contained.`);
        onOpenFile(); openFile('repo', f.p);
      } }));
    }
  }
  function renderList() {
    document.querySelectorAll('[data-code-tab]').forEach((b) => b.classList.toggle('on', b.dataset.codeTab === listTab));
    $('#code-changed').textContent = git?.changed ? String(git.changed) : '';
    const list = $('#code-tree'); const top = list.scrollTop;
    list.replaceChildren();
    if (listTab === 'files') renderTree(list, '', 0); else renderChanges(list);
    list.scrollTop = top;
  }

  // ------------------------------------------------------------ tabs and the editor
  async function ensureEditor() {
    if (editor) return editor;
    editorLoading ||= import('./editor.js');
    const { createEditor } = await editorLoading;
    if (!editor) {
      $('#code-editor .code-empty').hidden = true;
      editor = createEditor($('#code-editor'), {
        onChange(key) {
          const tab = tabByKey(key);
          if (!tab || tab.kind !== 'file') return;
          const dirty = editor.text(key) !== tab.saved;
          if (dirty !== tab.dirty) { tab.dirty = dirty; renderTabs(); }
        },
        onSave: save,
      });
    }
    return editor;
  }
  function renderTabs() {
    const bar = $('#code-tabs'); bar.replaceChildren();
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `code-tab${tab.key === active ? ' on' : ''}${tab.dirty ? ' dirty' : ''}`; el.setAttribute('role', 'tab');
      el.title = tab.kind === 'diff' ? 'Uncommitted changes' : `${tab.path}${tab.source === 'repo' ? '' : ` · ${agents.find((a) => a.id === tab.source)?.name || tab.source}'s worktree`}`;
      const name = document.createElement('button'); name.type = 'button'; name.className = 'nm';
      name.textContent = tab.kind === 'diff' ? 'Changes.diff' : baseName(tab.path);
      name.addEventListener('click', () => activate(tab.key));
      const close = document.createElement('button'); close.type = 'button'; close.className = 'x';
      close.textContent = tab.dirty ? '●' : '×'; close.setAttribute('aria-label', `Close ${name.textContent}`);
      close.addEventListener('click', () => closeTab(tab.key));
      el.append(name, close); bar.append(el);
    }
    const tab = current();
    $('#code-save').disabled = !tab || tab.kind !== 'file' || !tab.dirty;
    $('#code-chat').disabled = !tab;
    $('#code-vscode').disabled = !tab || tab.kind !== 'file';
    $('#code-share').disabled = !tab || tab.kind !== 'file' || tab.source === 'shared';
    if (editor) $('#code-editor .code-empty').hidden = !!tab;
  }
  function activate(key, reload = true) {
    active = key;
    editor?.show(key);
    renderTabs(); renderList();
    const tab = current();
    say(tab ? (tab.kind === 'diff' ? 'Read-only diff' : tab.path) : '');
    // A file an agent may have changed since: read it again, unless there are unsaved edits here.
    if (reload && tab?.kind === 'file' && !tab.dirty) readFile(tab.source, tab.path);
  }
  function closeTab(key) {
    const tab = tabByKey(key);
    if (!tab) return;
    if (tab.dirty && !confirm(`Close ${baseName(tab.path)} without saving your changes?`)) return;
    const index = tabs.indexOf(tab);
    tabs.splice(index, 1);
    editor?.drop(key);
    if (active === key) activate((tabs[index] || tabs[index - 1])?.key || null); else renderTabs();
  }
  const readFile = (src, path) => ask({ t: 'file', source: src, path }, { kind: 'file', source: src, path });
  const readDiff = (src) => ask({ t: 'diff', source: src, mode: 'combined' }, { kind: 'diff', source: src });
  function openFile(src, path) {
    const key = keyOf(src, path);
    if (tabByKey(key)) return activate(key);
    say(`Opening ${path}…`);
    readFile(src, path);
  }

  async function showFile(msg, note) {
    const key = keyOf(note.source, note.kind === 'diff' ? '\0diff' : note.path);
    const ed = await ensureEditor();
    let tab = tabByKey(key);
    const text = msg.text ?? '';
    if (tab?.dirty) return; // a reload must never replace unsaved edits
    if (!tab) {
      tab = { key, source: note.source, path: note.kind === 'diff' ? 'changes.diff' : note.path, kind: note.kind, saved: text, mtime: msg.mtime, dirty: false };
      tabs.push(tab);
      ed.open(key, { text, name: tab.path, readOnly: note.kind === 'diff' });
      activate(key, false);
      return;
    }
    tab.saved = text; tab.mtime = msg.mtime;
    ed.open(key, { text, name: tab.path, readOnly: note.kind === 'diff' });
    tab.dirty = false;
    if (key === active) { ed.show(key); renderTabs(); }
  }

  function save() {
    const tab = current();
    if (!tab || tab.kind !== 'file' || !tab.dirty || !editor) return;
    const text = editor.text(tab.key);
    if (ask({ t: 'savefile', source: tab.source, path: tab.path, text, mtime: tab.mtime }, { kind: 'save', key: tab.key, text })) say('Saving…');
  }

  function addToChat() {
    const tab = current();
    const agent = getSelected();
    if (!tab || !editor) return;
    if (!agent) return notify('Add an agent first, then send it this file.');
    const picked = editor.selection();
    const body = picked ? picked.text : editor.text(tab.key);
    const where = tab.kind === 'diff' ? 'Uncommitted changes (git diff)' : `File: ${tab.path}${picked ? ` (lines ${picked.from}-${picked.to})` : ''}`;
    const text = `${where}\n\n\`\`\`\n${body}\n\`\`\``;
    if (text.length > MAX_DRAFT) return notify('That is too large for a message. Select the lines you want to discuss, then press Add to chat again.');
    if (setDraft(agent, text)) say(picked ? 'Added the selected lines to the message box. Nothing was sent.' : 'Added to the message box. Nothing was sent.');
  }

  // ------------------------------------------------------------ wiring
  $('#code-source').addEventListener('change', (e) => setSource(e.target.value));
  $('#code-refresh').addEventListener('click', () => { say(''); refresh(); });
  document.querySelectorAll('[data-code-tab]').forEach((b) => b.addEventListener('click', () => { listTab = b.dataset.codeTab; renderList(); }));
  $('#code-save').addEventListener('click', save);
  $('#code-share').addEventListener('click', () => {
    const tab = current();
    if (!tab || tab.kind !== 'file') return;
    if (tab.source === 'shared') return say('This file is already shared with every agent.');
    if (tab.dirty) return say('Save the file first, then share it.');
    if (connected()) send({ t: 'sharefile', source: tab.source, path: tab.path });
  });
  $('#code-chat').addEventListener('click', addToChat);
  $('#code-diff').addEventListener('click', () => { say('Reading changes…'); readDiff(source); });
  $('#code-vscode').addEventListener('click', () => {
    const tab = current();
    if (tab?.kind === 'file' && connected()) send({ t: 'open-editor', source: tab.source, path: tab.path, line: editor?.line() || undefined });
  });
  window.addEventListener('beforeunload', (e) => { if (tabs.some((tab) => tab.dirty)) e.preventDefault(); });

  return {
    /** Open one file from the repository (`repo`) or an agent's worktree. */
    open(src, path) { if (src !== source && (src === 'repo' || src === 'shared' || agents.some((a) => a.id === src))) setSource(src); openFile(src, path); },
    /** The side panel started (or stopped) showing the code view. */
    shown() { renderSources(); refresh(); },
    setAgents(list) {
      agents = (list || []).filter((a) => a.provider !== 'api').map((a) => ({ id: a.id, name: a.name })); // API chats have no folder of their own
      renderSources();
    },
    setGit(next) { git = next; renderList(); reloadTree(); },
    /** The server became reachable: load the tree. */
    online() { renderSources(); refresh(); },
    /** Show another folder (the repository or an agent's worktree) in the tree. */
    setSource(src) { if (src !== source && (src === 'repo' || src === 'shared' || agents.some((a) => a.id === src))) setSource(src); },
    /** Read the open folders again (something was added to one). */
    refreshTree() { lastTreeLoad = 0; reloadTree(); },
    /** Another project was opened: nothing here belongs to it. */
    repoChanged() {
      for (const tab of tabs.splice(0)) editor?.drop(tab.key);
      active = null; source = 'repo'; pending.clear(); dirs.clear(); expanded.clear(); expanded.add('');
      renderTabs(); renderSources(); say('');
      refresh();
    },
    receive(msg) {
      if (msg.t !== 'inspect') return false;
      const note = pending.get(msg.request);
      pending.delete(msg.request);
      if (!note || (note.source === 'repo' && msg.cwd !== getRepo())) return true; // an answer for a folder we have left
      if (msg.error) {
        say(msg.error, true);
        if (note.kind === 'files' && note.path) { expanded.delete(note.path); renderList(); }
        return true;
      }
      if (note.kind === 'files') {
        if (note.source !== source) return true;
        dirs.set(note.path, msg.entries || []);
        if (msg.truncated) say('Only the first 300 entries of a folder are listed.');
        renderList();
      } else if (note.kind === 'save') {
        const tab = tabByKey(note.key);
        if (!tab) return true;
        tab.saved = note.text; tab.mtime = msg.mtime;
        tab.dirty = editor.text(tab.key) !== tab.saved;
        renderTabs();
        say(`Saved ${tab.path}`);
      } else {
        showFile(msg, note).then(() => { if (note.kind === 'diff' || !msg.bytes) return; if (active === keyOf(note.source, note.path)) say(note.path); });
      }
      return true;
    },
  };
}
