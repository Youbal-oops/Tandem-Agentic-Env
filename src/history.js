export function createChatHistory({ send, connected, getRepo, getName, notify }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'history-dialog';
  dialog.innerHTML = '<header><div><span class="eyebrow">SAVED ON THIS COMPUTER</span><h2>Chat history</h2></div><button class="history-close">Close ×</button></header><p class="history-location"></p><input class="history-search" type="search" placeholder="Find a conversation…" aria-label="Search conversations" /><p class="history-status" role="status"></p><nav class="history-list" aria-label="Saved conversations"></nav>';
  document.body.append(dialog);
  const $ = (selector) => dialog.querySelector(selector);
  let agent, cwd, request = 0, conversations = [];
  function render() {
    const list = $('.history-list'); list.replaceChildren();
    const search = $('.history-search').value.trim().toLowerCase();
    const rows = conversations.filter((row) => row.title.toLowerCase().includes(search));
    $('.history-status').textContent = rows.length ? 'Choose a conversation to continue it.' : 'No saved conversations found.';
    for (const row of rows) {
      const button = document.createElement('button'); button.className = 'history-entry';
      const title = document.createElement('span'); title.textContent = row.title;
      const detail = document.createElement('small');
      detail.textContent = `${row.messages} message${row.messages === 1 ? '' : 's'} · ${new Date(row.updatedAt).toLocaleString()}${row.active ? ' · Current chat' : ''}`;
      button.append(title, detail); button.disabled = row.active;
      button.addEventListener('click', () => {
        if (!connected()) return notify('Connect to the local server first.');
        if (cwd !== getRepo()) return notify('Project changed. Reopen chat history.');
        send({ t: 'chat-reopen', agent, cwd, id: row.id });
      });
      list.append(button);
    }
  }
  $('.history-close').addEventListener('click', () => dialog.close());
  $('.history-search').addEventListener('input', render);
  return {
    open(id) {
      if (!connected()) return notify('Connect to the local server first.');
      agent = id; cwd = getRepo(); conversations = [];
      $('.history-location').textContent = `${getName(id)} · ${cwd}`;
      $('.history-search').value = ''; $('.history-list').replaceChildren();
      $('.history-status').textContent = 'Loading conversations…';
      dialog.showModal(); send({ t: 'chat-history', agent, request: ++request });
    },
    receive(msg) {
      if (msg.t === 'chat-history') {
        if (msg.request === request && msg.agent === agent && msg.cwd === cwd && cwd === getRepo()) { conversations = msg.conversations; render(); }
        return true;
      }
      if (msg.t === 'chat-reopened') { if (msg.agent === agent) dialog.close(); return true; }
      return false;
    },
  };
}
