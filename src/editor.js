// The code editor (CodeMirror 6). This file is only downloaded when the first file is opened in the code view, and each
// language's grammar is only downloaded when a file of that kind is opened. Every open tab keeps its own editor state, so
// undo history and the cursor survive switching tabs.

import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';

// Colours follow VS Code's default dark theme, so code reads the same in both places.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword], color: '#569cd6' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#c586c0' },
  { tag: [t.string, t.special(t.string), t.attributeValue], color: '#ce9178' },
  { tag: [t.regexp, t.escape], color: '#d16969' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6a9955' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#b5cea8' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#dcdcaa' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: '#4ec9b0' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.labelName], color: '#9cdcfe' },
  { tag: [t.definition(t.variableName), t.self], color: '#9cdcfe' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#d4d4d4' },
  { tag: t.meta, color: '#808080' },
  { tag: t.heading, color: '#569cd6', fontWeight: '600' },
  { tag: t.link, color: '#4fc1ff', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.inserted, color: '#89d185' },
  { tag: t.deleted, color: '#f48771' },
  { tag: t.invalid, color: '#f44747' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: '#d4d4d4', backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--code)', lineHeight: '1.55' },
  '.cm-content': { caretColor: '#fff', padding: '8px 0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: '#fff' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#6e7681', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#c9d1d9' },
  '.cm-activeLine': { backgroundColor: '#ffffff0a' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264f78' },
  '.cm-selectionMatch': { backgroundColor: '#ffffff1a' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: '#ffffff1f', outline: '1px solid #ffffff33' },
  '.cm-foldPlaceholder': { backgroundColor: '#ffffff14', border: 'none', color: '#9aa0a6' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)', borderTop: '1px solid var(--line)' },
  '.cm-panels input, .cm-panels button': { font: 'inherit' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', border: '1px solid var(--line)', color: 'var(--ink)' },
}, { dark: true });

/**
 * `onChange(key)` runs when the text of a tab changes; `onSave()` on Ctrl+S.
 * Returns { open, show, drop, text, selection, has, current, focus }.
 */
export function createEditor(host, { onChange, onSave }) {
  const tabs = new Map(); // key -> { state, language: Compartment }
  let current = null;
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: '' }) });
  view.dom.hidden = true;

  /** Keep the stored state of the tab on screen up to date before looking at another one. */
  const stash = () => { if (current && tabs.has(current)) tabs.get(current).state = view.state; };
  const apply = (key, spec) => {
    const tab = tabs.get(key);
    if (!tab) return;
    if (key === current) view.dispatch(spec); else tab.state = tab.state.update(spec).state;
  };

  return {
    has: (key) => tabs.has(key),
    current: () => current,
    /** Create a tab, or replace its text (a reload from disk) while keeping it in place. */
    open(key, { text, name, readOnly = false }) {
      const existing = tabs.get(key);
      if (existing) {
        const state = key === current ? view.state : existing.state;
        if (state.doc.toString() !== text) apply(key, { changes: { from: 0, to: state.doc.length, insert: text } });
        return;
      }
      const language = new Compartment();
      const state = EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab, { key: 'Mod-s', run: () => { onSave(); return true; } }]),
          theme,
          syntaxHighlighting(highlight),
          language.of([]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.updateListener.of((update) => { if (update.docChanged) onChange(key); }),
        ],
      });
      tabs.set(key, { state, language });
      LanguageDescription.matchFilename(languages, name)?.load()
        .then((support) => apply(key, { effects: language.reconfigure(support) }))
        .catch(() => { /* no grammar: the file stays plain text */ });
    },
    show(key) {
      stash();
      current = tabs.has(key) ? key : null;
      view.dom.hidden = !current;
      if (current) view.setState(tabs.get(current).state);
    },
    drop(key) {
      tabs.delete(key);
      if (current === key) { current = null; view.dom.hidden = true; }
    },
    text(key) { return (key === current ? view.state : tabs.get(key)?.state)?.doc.toString() ?? ''; },
    /** The selected text of the tab on screen, with the lines it spans; empty when nothing is selected. */
    selection() {
      if (!current) return null;
      const range = view.state.selection.main;
      if (range.empty) return null;
      return { text: view.state.sliceDoc(range.from, range.to), from: view.state.doc.lineAt(range.from).number, to: view.state.doc.lineAt(range.to).number };
    },
    /** The line the cursor is on, for "open in VS Code". */
    line() { return current ? view.state.doc.lineAt(view.state.selection.main.head).number : 0; },
    focus() { if (current) view.focus(); },
  };
}
