// A protocol fixture, never a real model request.
import readline from 'node:readline';
const provider = process.argv[2];
const args = process.argv.slice(3);
const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
if (provider === 'gemini') {
  let text = '';
  process.stdin.on('data', (c) => text += c);
  process.stdin.on('end', () => {
    emit({ type: 'init', session_id: 'gem-session-1', model: 'gemini-fixture' });
    emit({ type: 'message', role: 'user', content: text });
    emit({ type: 'message', role: 'assistant', content: 'Looking at ', delta: true });
    emit({ type: 'message', role: 'assistant', content: 'the file.', delta: true });
    emit({ type: 'tool_use', tool_name: 'replace', tool_id: 'call-1', parameters: { file_path: 'a.txt', old_string: 'one', new_string: 'two' } });
    emit({ type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'ok' });
    emit({ type: 'message', role: 'assistant', content: JSON.stringify({ args, text }), delta: true });
    emit({ type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 7, duration_ms: 9 } });
  });
} else if (provider === 'codex') {
  let text = '';
  process.stdin.on('data', (s) => text += s);
  process.stdin.on('end', () => setTimeout(() => {
    emit({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' });
    emit({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: JSON.stringify({ args, text }) } });
    emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  }, text.includes('SLOW-TURN') ? 900 : 0)); // lets a test keep a main agent busy while something else finishes
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
