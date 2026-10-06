// The learning journal dialog: a read-only list of the steps finished in this project, newest first.
// The entries live in the project's .tandem/LEARNING.md; this just shows them.

export function createJournalDialog({ send, connected, notify }) {
  const $ = (s) => document.querySelector(s);
  const dialog = $('#journal-dialog');

  function render(entries) {
    const list = $('#journal-list'); list.replaceChildren();
    $('#journal-clear').disabled = !entries.length;
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = 'Nothing here yet. Each time you approve a step in learning mode and the agent finishes it, a short note lands here, and the next session starts from it.';
      list.append(empty);
      return;
    }
    for (const e of [...entries].reverse()) {
      const card = document.createElement('article'); card.className = 'journal-entry';
      const head = document.createElement('header');
      const title = document.createElement('b'); title.textContent = e.title || 'Step';
      const time = document.createElement('time'); time.textContent = e.at;
      head.append(title, time);
      card.append(head);
      for (const [label, key] of [['Request', 'request'], ['Design', 'design'], ['Choices', 'choices'], ['Files', 'files'], ['Report', 'report']]) {
        if (!e.fields[key] || e.fields[key] === '-') continue;
        const row = document.createElement('p');
        const name = document.createElement('i'); name.textContent = label;
        row.append(name, document.createTextNode(e.fields[key]));
        card.append(row);
      }
      list.append(card);
    }
  }

  $('#btn-journal').addEventListener('click', () => {
    if (!connected()) { notify('Connect to the local server first.'); return; }
    dialog.showModal();
    send({ t: 'journal' });
  });
  $('#close-journal').addEventListener('click', () => dialog.close());
  $('#journal-clear').addEventListener('click', () => {
    if (confirm('Delete the learning journal for this project? Agents will no longer be reminded of earlier steps.')) send({ t: 'journal-clear' });
  });

  return {
    receive(msg) {
      if (msg.t !== 'journal') return false;
      render(msg.entries || []);
      return true;
    },
  };
}
