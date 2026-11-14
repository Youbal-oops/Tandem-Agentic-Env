// Markdown to safe HTML, shared by the agent chats and the Team chat. Links open in a new window, never in this one.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
export const md = (src) => DOMPurify.sanitize(marked.parse(src || ''));
