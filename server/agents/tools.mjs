// What a tool call is (read, shell, edit ...) and a one-line summary of it for the chat.

import { trunc } from './util.mjs';

const CLASS_BY_NAME = {
  Read: 'read', Glob: 'read', LS: 'read', NotebookRead: 'read',
  Grep: 'search',
  WebSearch: 'web', WebFetch: 'web', Search: 'web',
  Bash: 'shell', PowerShell: 'shell', Shell: 'shell',
  Write: 'edit', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Task: 'agent', Agent: 'agent',
  TodoWrite: 'plan', TaskCreate: 'plan', TaskUpdate: 'plan', TaskList: 'plan', TaskGet: 'plan', TaskStop: 'plan', TaskOutput: 'plan',
};
/** Gemini CLI's tool names, as the Claude-style names the chat, review and learning code already understand. */
export const GEMINI_TOOL = {
  read_file: 'Read', read_many_files: 'Read', list_directory: 'LS', glob: 'Glob',
  grep_search: 'Grep', search_file_content: 'Grep', google_web_search: 'WebSearch', web_fetch: 'WebFetch',
  run_shell_command: 'Shell', write_file: 'Write', replace: 'Edit', write_todos: 'TodoWrite',
};
export const toolClass = (name = '') => CLASS_BY_NAME[name] || (/^mcp__|\./.test(name) ? 'mcp' : 'other');

/** Path helpers bound to one working folder: paths inside it are shown relative to it. */
export function createSummarizer(cwd) {
  const rel = (p) => {
    p = String(p ?? '');
    const base = cwd.replace(/[\\/]+$/, '');
    return p.toLowerCase().startsWith(base.toLowerCase() + '\\') || p.toLowerCase().startsWith(base.toLowerCase() + '/') ? p.slice(base.length + 1) : p;
  };

  function summarize(name, input = {}) {
    const pick = (...ks) => ks.map((k) => input?.[k]).find((v) => typeof v === 'string' && v) || '';
    switch (name) {
      case 'Shell':
      case 'Bash':
      case 'PowerShell':
        return trunc(pick('command'), 200);
      case 'Read':
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
      case 'NotebookEdit':
        return rel(pick('file_path', 'notebook_path', 'absolute_path', 'path'));
      case 'Glob':
      case 'Grep':
        return pick('pattern', 'dir_path');
      case 'WebFetch':
        return pick('url');
      case 'WebSearch':
        return pick('query');
      case 'Task':
      case 'Agent':
        return trunc(pick('description', 'prompt'), 120);
      case 'TodoWrite':
        return `${(input.todos || []).length} items`;
      default:
        try {
          return trunc(JSON.stringify(input), 160);
        } catch {
          return '';
        }
    }
  }
  return { rel, summarize };
}
