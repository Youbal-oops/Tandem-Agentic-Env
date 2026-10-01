// A protocol fixture, never a real model request.
import readline from 'node:readline';
const provider = process.argv[2];
const args = process.argv.slice(3);
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
if (provider === 'codex') {
  let text = '';
  process.stdin.on('data', (s) => text += s);
  process.stdin.on('end', () => {
    emit({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' });
    emit({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: JSON.stringify({ args, text }) } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  });
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('close', () => process.exit(0));
  emit({ type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000002' });
  let seq = 0;
  lines.on('line', (s) => {
    const msg = JSON.parse(s);
    emit({ type: 'assistant', message: { id: `reply-${process.pid}-${++seq}`, content: [{ type: 'text', text: JSON.stringify({ args, text: msg.message.content }) }] } });
    emit({ type: 'result', subtype: 'success', duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  });
}
