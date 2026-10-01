export function createFolderPicker({ send, connected, getRepo, notify }) {
  const $ = s => document.querySelector(s);
  const dialog = $('#folder-dialog');
  let request = 0, current = '', parent = '', home = '', pending = false;
  function browse(path) {
    if (!connected()) { notify('Connect to the local server to browse folders.'); return; }
    pending = true;
    $('#choose-folder').disabled = true;
    $('#folder-status').textContent = 'Loading folders…';
    send({ t: 'folders', path, request: ++request });
  }
  $('#browse-repo').onclick = () => { dialog.showModal(); browse($('#repo-path').value.trim() || getRepo()); };
  $('#close-folders').onclick = () => dialog.close();
  $('#folder-up').onclick = () => browse(parent);
  $('#folder-home').onclick = () => browse(home || undefined);
  $('#folder-current').onclick = () => browse(getRepo());
  $('#folder-path-form').onsubmit = e => { e.preventDefault(); browse($('#folder-path').value.trim()); };
  $('#folder-search').oninput = () => {
    const query = $('#folder-search').value.toLowerCase();
    for (const row of $('#folder-list').children) row.hidden = !row.textContent.toLowerCase().includes(query);
  };
  $('#choose-folder').onclick = () => {
    if (pending || !current) return;
    $('#repo-path').value = current;
    dialog.close();
    $('#repo-form button[type="submit"]').focus();
  };
  return { receive(msg) {
    if (msg.t !== 'folders') return false;
    if (msg.request !== request) return true;
    pending = false;
    if (msg.error) { $('#folder-status').textContent = msg.error; return true; }
    current = msg.path; parent = msg.parent; home = msg.home;
    $('#folder-path').value = current;
    $('#folder-up').disabled = current === parent;
    $('#choose-folder').disabled = false;
    $('#folder-status').textContent = `${msg.repo ? 'Git repository' : 'Local folder'} · ${msg.folders.length} folders${msg.truncated ? ' (first 500 shown; enter a path to navigate further)' : ''}`;
    $('#folder-selection').textContent = current;
    $('#folder-search').value = '';
    const roots = $('#folder-roots'); roots.replaceChildren();
    for (const root of msg.roots) { const b = document.createElement('button'); b.textContent = root; b.onclick = () => browse(root); roots.append(b); }
    const list = $('#folder-list'); list.replaceChildren();
    for (const folder of msg.folders) {
      const b = document.createElement('button'); b.className = 'folder-entry';
      const icon = document.createElement('span'); icon.className = 'folder-icon'; icon.textContent = '▱';
      const name = document.createElement('span'); name.textContent = folder.name;
      const badge = document.createElement('small'); badge.textContent = folder.repo ? 'Git repo  →' : '→';
      b.append(icon, name, badge); b.onclick = () => browse(folder.path); list.append(b);
    }
    if (!msg.folders.length) { const p = document.createElement('p'); p.textContent = 'No subfolders. You can select this folder or go up a level.'; list.append(p); }
    return true;
  } };
}
