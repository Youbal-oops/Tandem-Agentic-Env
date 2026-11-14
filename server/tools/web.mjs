// Searching the web and downloading files for an agent. Downloads land inside the agent's own folder, never elsewhere,
// and never overwrite a file unless asked. Only http and https addresses are used.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_DOWNLOAD = 50 * 1024 * 1024;
const DOWNLOAD_MS = 120000;
const SEARCH_MS = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Tandem/1.0';

export function webUrl(value) {
  let u;
  try { u = new URL(String(value)); } catch { throw new Error('That is not a web address.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https addresses can be used.');
  if (u.username || u.password) throw new Error('Addresses with a username or password are not allowed.');
  return u.href;
}

const decode = (s) => s.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[e]).replace(/\s+/g, ' ').trim();

/** DuckDuckGo's plain HTML results, which need no account or key. Returns `[{ title, url, snippet }]`. */
export function parseResults(html, max) {
  const results = [];
  const links = [...html.matchAll(/<a\b([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)];
  links.forEach((m, i) => {
    if (results.length >= max) return;
    let url = (/href="([^"]+)"/.exec(m[1])?.[1] || '').replace(/&amp;/g, '&');
    const wrapped = /[?&]uddg=([^&]+)/.exec(url);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    else if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) return; // adverts and broken rows
    const after = html.slice(m.index + m[0].length, links[i + 1]?.index ?? html.length); // this result's own snippet sits before the next result
    const snippet = decode(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(after)?.[1] || '');
    results.push({ title: decode(m[2]), url, snippet });
  });
  return results;
}

export function createWeb({ fetchImpl = fetch } = {}) {
  async function search(query, maxResults = 8) {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) throw new Error('Give something to search for.');
    const max = Math.min(15, Math.max(1, Number(maxResults) || 8));
    const res = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(SEARCH_MS) });
    if (!res.ok) throw new Error(`The search service answered ${res.status}. Try again, or open a search page with browser_open.`);
    const results = parseResults(await res.text(), max);
    if (!results.length) throw new Error('No results came back (the search service may be limiting requests). Try different words, or use browser_open on a search page.');
    return { query: q, results };
  }

  /** Save `url` to `relPath` inside `cwd`. */
  async function download(cwd, url, relPath, { overwrite = false } = {}) {
    url = webUrl(url);
    const rel = String(relPath || '').trim();
    if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('Give a path inside your folder, such as assets/logo.png (no .. and not absolute).');
    const root = fs.realpathSync(cwd);
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('That path is outside your folder.');
    if (target.split(path.sep).includes('.git') || /(^|[\\/])\.tandem([\\/]|$)/.test(path.relative(root, target))) throw new Error('Downloads cannot go into .git or .tandem.');
    if (fs.existsSync(target) && !overwrite) throw new Error(`${rel} already exists. Choose another name, or set overwrite to true.`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // The folder may have been a link pointing out of the worktree: check where the new file's folder really is.
    const realDir = fs.realpathSync(path.dirname(target));
    if (realDir !== root && !realDir.startsWith(root + path.sep)) throw new Error('That path is outside your folder.');
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!res.ok || !res.body) throw new Error(`The server answered ${res.status} for ${url}.`);
    const declared = Number(res.headers.get('content-length')) || 0;
    if (declared > MAX_DOWNLOAD) throw new Error(`The file is ${Math.round(declared / 1048576)} MB; the limit is ${MAX_DOWNLOAD / 1048576} MB.`);
    const part = `${target}.tandem-part`;
    let bytes = 0;
    try {
      const counted = Readable.fromWeb(res.body);
      counted.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_DOWNLOAD) counted.destroy(new Error(`Stopped: the file is larger than ${MAX_DOWNLOAD / 1048576} MB.`)); });
      await pipeline(counted, fs.createWriteStream(part));
      fs.renameSync(part, target);
    } catch (e) { fs.rmSync(part, { force: true }); throw e; }
    return { path: path.relative(root, target).replace(/\\/g, '/'), bytes, contentType: res.headers.get('content-type') || undefined, from: res.url || url };
  }

  return { search, download };
}
