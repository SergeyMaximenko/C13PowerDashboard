import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { buildPages } from '../tools/build-pages.mjs';
import { publicStatus } from '../lib/public-status.mjs';

test('public export excludes credentials, identifiers and upstream errors', () => {
  const data = publicStatus({ station: { id: 'private-id', name: 'Чавдар 13' },
    password: 'secret', accessToken: 'token', historyError: 'private response',
    collectedAt: Date.now(), stale: false, output: 'on', grid: 'off',
    events: { appeared: { from: 100, to: 200, at: 150, secret: 'hidden' } } });
  const json = JSON.stringify(data);
  for (const value of ['private-id', 'secret', 'token', 'private response', 'hidden']) assert.ok(!json.includes(value));
  assert.equal(data.output, 'on');
  assert.equal(data.events.appeared.at, 150);
});

test('Pages artifact has relative assets, versioned script and styles, and no secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'c13-pages-'));
  try {
    await buildPages(directory);
    const html = await readFile(path.join(directory, 'index.html'), 'utf8');
    const scriptHash = createHash('sha256').update(await readFile(new URL('../public/app.js', import.meta.url))).digest('hex').slice(0, 16);
    assert.ok(html.includes('src="./app.js?v=' + scriptHash + '"'));
    const styleHash = createHash('sha256').update(await readFile(new URL('../public/styles.css', import.meta.url))).digest('hex').slice(0, 16);
    assert.ok(html.includes('href="./styles.css?v=' + styleHash + '"'));
    assert.deepEqual((await readdir(directory)).sort(), ['.nojekyll', 'app.js', 'favicon.svg', 'index.html', 'styles.css', 'iphone-step-1.png', 'iphone-step-2.png', 'iphone-step-3.png',
      'generator.html', 'generator.js', 'generator-lib.js', 'generator.css'].sort());
    // The separate report page: versioned script, styles and the import of the helper module.
    const report = await readFile(path.join(directory, 'generator.html'), 'utf8');
    const script = await readFile(path.join(directory, 'generator.js'), 'utf8');
    const hash = file => readFile(new URL('../public/' + file, import.meta.url)).then(bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16));
    assert.ok(report.includes('src="./generator.js?v=' + createHash('sha256').update(script).digest('hex').slice(0, 16) + '"'));
    assert.ok(report.includes('href="./generator.css?v=' + await hash('generator.css') + '"'));
    assert.ok(script.includes("from './generator-lib.js?v=" + await hash('generator-lib.js') + "'"));
    assert.match(report, /name="dashboard-api" content="https:\/\/[^"]+"/);
    // The report page has a password field (empty); no secret value or secret name may be in it.
    assert.ok(!/secret|token|REPORT_PASSWORD/i.test(report));
    assert.ok(!/type="password"[^>]*value=/i.test(report));
    assert.match(html, /name="dashboard-api" content="https:\/\/[^"]+"/);
    assert.ok(!/secret|password|token/i.test(html));
  } finally {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('c13-pages-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

async function browserApi(content, search = '') {
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = script.slice(script.indexOf('async function api('), script.indexOf('async function refresh('));
  const calls = [];
  const api = vm.runInNewContext(code + '; api;', {
    URL, URLSearchParams, Date, AbortSignal, location: { search },
    document: { querySelector: () => ({ content }) },
    fetch: async url => { calls.push(String(url)); return Response.json({ collectedAt: Date.now() }); }
  });
  return { api, calls };
}

test('the page reads live data from the configured Worker address', async () => {
  const { api, calls } = await browserApi('https://c13.example.workers.dev');
  await api();
  assert.equal(calls[0], 'https://c13.example.workers.dev/api/status');
});

test('the page may open another allowed station with ?station=ID and ignores invalid values', async () => {
  const other = await browserApi('https://c13.example.workers.dev', '?station=61167187');
  await other.api();
  assert.equal(other.calls[0], 'https://c13.example.workers.dev/api/status?station=61167187');
  const invalid = await browserApi('https://c13.example.workers.dev', '?station=abc');
  await invalid.api();
  assert.equal(invalid.calls[0], 'https://c13.example.workers.dev/api/status');
  const local = await browserApi('https://c13.example.workers.dev', '?api=http://127.0.0.1:8787');
  await local.api();
  assert.equal(local.calls[0], 'http://127.0.0.1:8787/api/status');
  const foreign = await browserApi('https://c13.example.workers.dev', '?api=https://evil.example');
  await foreign.api();
  assert.equal(foreign.calls[0], 'https://c13.example.workers.dev/api/status');
  const missing = await browserApi('');
  await assert.rejects(missing.api(), /адресу джерела/);
});
