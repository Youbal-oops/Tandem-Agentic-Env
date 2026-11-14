// The top bar's menus (File, Edit, View, Agents, Help) and the sidebar's collapsible sections.
// A menu item either is a real control (it has its own id and handler elsewhere), forwards a click to one
// (`data-click="#id"`), or runs an editing command (`data-cmd`). Menu items never take focus, so Edit commands act
// on whatever text field you were in.

import { $ } from './state.js';

const SHORTCUTS = 'Alt+0 Team · Alt+1…8 an agent · Ctrl+R Review · Ctrl+B Code · Ctrl+E VS Code · Ctrl+` Terminal · Ctrl+\\ sidebar · Ctrl+F search a chat · Esc clears the message box, or stops a running task';
const SECTIONS_KEY = 'tandem:rail-collapsed';

export function initMenus(app) {
  const menus = [...document.querySelectorAll('#topbar .menu')];
  let openMenu = null;

  function setOpen(menu) {
    for (const m of menus) {
      const on = m === menu;
      m.classList.toggle('open', on);
      m.querySelector('.menu-btn').setAttribute('aria-expanded', String(on));
    }
    openMenu = menu;
  }
  for (const m of menus) {
    const button = m.querySelector('.menu-btn');
    button.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the text field you were editing
    button.addEventListener('click', () => setOpen(openMenu === m ? null : m));
    button.addEventListener('mouseenter', () => { if (openMenu && openMenu !== m) setOpen(m); }); // slide across like a desktop menu bar
    for (const entry of m.querySelectorAll('.menu-list button')) {
      entry.addEventListener('mousedown', (e) => e.preventDefault());
      entry.addEventListener('click', () => { setOpen(null); run(entry); });
    }
  }
  document.addEventListener('click', (e) => { if (openMenu && !openMenu.contains(e.target)) setOpen(null); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { e.stopPropagation(); setOpen(null); } }, true);
  window.addEventListener('blur', () => setOpen(null));

  async function run(entry) {
    if (entry.dataset.click) { $(entry.dataset.click)?.click(); return; }
    const command = entry.dataset.cmd;
    if (!command) return; // a real control: its own handler has already run
    if (command === 'reload') return location.reload();
    if (command === 'close') return window.close();
    if (command === 'shortcuts') return app.showNotice(SHORTCUTS);
    if (command === 'paste') {
      try { const text = await navigator.clipboard.readText(); if (text) document.execCommand('insertText', false, text); }
      catch { app.showNotice('Tandem could not read the clipboard. Press Ctrl+V instead.'); }
      return;
    }
    document.execCommand(command);
  }

  // ---- sidebar sections that fold away, remembered between sessions
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '[]'); } catch { collapsed = []; }
  if (!Array.isArray(collapsed)) collapsed = [];
  for (const section of document.querySelectorAll('#rail .rail-sec')) {
    const name = section.dataset.sec;
    const toggle = section.querySelector('.sec-toggle');
    const apply = (folded) => { section.classList.toggle('collapsed', folded); toggle.setAttribute('aria-expanded', String(!folded)); };
    apply(collapsed.includes(name));
    toggle.addEventListener('click', () => {
      const folded = !section.classList.contains('collapsed');
      apply(folded);
      collapsed = folded ? [...new Set([...collapsed, name])] : collapsed.filter((n) => n !== name);
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(collapsed)); } catch { /* not remembered */ }
    });
  }
}
