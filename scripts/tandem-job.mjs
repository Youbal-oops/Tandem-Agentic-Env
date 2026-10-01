// Local delegation transport; no MCP or model API keys.
const [action, target, ...rest] = process.argv.slice(2);
try {
  if (!['start', 'status', 'result', 'message', 'cancel'].includes(action)) throw new Error('Usage: start <claude|codex> "task" | status <id> | result <id> | message <id> "text" | cancel <id>');
  if (!process.env.TANDEM_JOB_URL || !process.env.TANDEM_JOB_TOKEN) throw new Error('Run this command from an agent launched by Tandem.');
  const body = action === 'start' ? { action, provider: target, text: rest.join(' ') } : { action, id: target, text: rest.join(' ') };
  const response = await fetch(process.env.TANDEM_JOB_URL, { method: 'POST', headers: { Authorization: `Bearer ${process.env.TANDEM_JOB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (e) { process.stderr.write(e.message + '\n'); process.exitCode = 1; }
