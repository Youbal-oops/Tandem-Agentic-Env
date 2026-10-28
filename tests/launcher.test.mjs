import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLauncher, editorLaunch, terminalLaunch } from '../server/launcher.mjs';

const decode = (launch) => Buffer.from(launch.args.at(-1), 'base64').toString('utf16le');

test('Windows terminal opens in the folder: Windows Terminal when installed, else PowerShell', () => {
  assert.match(decode(terminalLaunch('win32', 'C:\\My Repo', { wt: true })), /wt\.exe -ArgumentList '-d', '"C:\\My Repo"'/);
  assert.match(decode(terminalLaunch('win32', "C:\\it's", { wt: false })), /powershell\.exe -WorkingDirectory 'C:\\it''s' -ArgumentList '-NoExit'/);
  assert.match(decode(terminalLaunch('win32', 'C:\\', { wt: true })), /'"C:\\\\"'/); // a trailing backslash must not swallow the closing quote
});

test('macOS and Linux terminals open in the folder', () => {
  assert.deepEqual(terminalLaunch('darwin', '/p/repo'), { cmd: 'open', args: ['-a', 'Terminal', '/p/repo'] });
  assert.deepEqual(terminalLaunch('linux', '/p/repo'), { cmd: 'x-terminal-emulator', args: [], cwd: '/p/repo' });
});

test('the editor opens VS Code on a folder or a file, and the default app when VS Code is missing', () => {
  assert.match(decode(editorLaunch('win32', 'C:\\r', { code: 'C:\\vs\\Code.exe' })), /-FilePath 'C:\\vs\\Code\.exe' -ArgumentList '"C:\\r"'/);
  assert.match(decode(editorLaunch('win32', 'C:\\r\\a.js', { code: 'C:\\vs\\Code.exe', isFile: true })), /-ArgumentList '--goto', '"C:\\r\\a\.js"'/);
  assert.match(decode(editorLaunch('win32', 'C:\\r', {})), /^Start-Process -FilePath 'C:\\r'$/);
  assert.deepEqual(editorLaunch('linux', '/r/a.js', { code: 'code', isFile: true }), { cmd: 'code', args: ['--goto', '/r/a.js'] });
  assert.deepEqual(editorLaunch('linux', '/r', {}), { cmd: 'xdg-open', args: ['/r'] });
  assert.deepEqual(editorLaunch('darwin', '/r', { code: 'Visual Studio Code' }), { cmd: 'open', args: ['-a', 'Visual Studio Code', '/r'] });
});

function fakeSpawn(calls, fail) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter(); child.unref = () => {};
    setImmediate(() => (fail ? child.emit('error', new Error('spawn failed')) : child.emit('spawn')));
    return child;
  };
}

test('the launcher finds VS Code, starts a detached process, and reports what it used', async () => {
  const calls = [];
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const withCode = createLauncher({ platform: 'win32', spawnImpl: fakeSpawn(calls), exists: (p) => p.endsWith('Code.exe'), env, execImpl: () => { throw new Error('no wt'); } });
  assert.deepEqual(await withCode.openEditor('C:\\r'), { using: 'VS Code' });
  assert.deepEqual(await withCode.openTerminal('C:\\r'), { using: 'PowerShell' });
  assert.equal(calls[0].opts.detached, true);
  const without = createLauncher({ platform: 'win32', spawnImpl: fakeSpawn(calls), exists: () => false, env, execImpl: () => Buffer.from('') });
  assert.deepEqual(await without.openEditor('C:\\r'), { using: 'default app' });
  assert.deepEqual(await without.openTerminal('C:\\r'), { using: 'Windows Terminal' });
});

test('VS Code installed on another drive is found through the PATH', async () => {
  const calls = [];
  const launcher = createLauncher({
    platform: 'win32', spawnImpl: fakeSpawn(calls), env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    exists: (p) => p === 'D:\\Microsoft VS Code\\Code.exe',
    execImpl: (file) => (file === 'where.exe' ? 'D:\\Microsoft VS Code\\bin\\code.cmd\r\n' : (() => { throw new Error('none'); })()),
  });
  assert.deepEqual(await launcher.openEditor('C:\\r\\a.js', true, 4), { using: 'VS Code' });
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /-FilePath 'D:\\Microsoft VS Code\\Code\.exe' -ArgumentList '--goto', '"C:\\r\\a\.js:4"'/);
});

test('a process that cannot start is reported, not ignored', async () => {
  const l = createLauncher({ platform: 'linux', spawnImpl: fakeSpawn([], true), execImpl: () => { throw new Error('none'); } });
  await assert.rejects(l.openTerminal('/r'), /spawn failed/);
});
