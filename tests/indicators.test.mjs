import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, parseIndicators } from '../lib/indicators.mjs';
import { createHandler } from '../worker/index.mjs';

const TEXT = `<b>Показники станом на:</b>
📅 13.11.2026 Пт (сьогодні)
 🕒 23:24

<b>Стан по паливу:</b>
⛽️ залишок у баку ~ <b>111 л.</b>
🟩🟩⬜️<b>93%</b>

<b>Остання заправка:</b>
📅 01.03.2026 Нд
🙏 заправляв <b>Sergii</b>
👤 <b><a href="https://t.me/SergiiNM" target="_blank">t.me/SergiiNM</a></b>`;

test('sanitize: allows b/i/u/blockquote and t.me links, escapes everything else', () => {
  assert.equal(sanitizeHtml('<b>a</b> <i>b</i> 5 < 6 & 7'), '<b>a</b> <i>b</i> 5 &lt; 6 &amp; 7');
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(sanitizeHtml('<b onclick="x">a</b>'), '&lt;b onclick="x"&gt;a</b>');
  assert.equal(sanitizeHtml('<a href="https://t.me/abc_def" target="_blank">x</a>'),
    '<a href="https://t.me/abc_def" target="_blank" rel="noopener noreferrer">x</a>');
  assert.equal(sanitizeHtml('<a href="https://evil.example/">x</a>'), '&lt;a href="https://evil.example/"&gt;x&lt;/a&gt;');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>').includes('<a '), false);
  assert.equal(sanitizeHtml('<a href="https://t.me/abc">x'), '<a href="https://t.me/abc" target="_blank" rel="noopener noreferrer">x</a>');
});

test('indicators: sections by blank lines, first block dropped, title without colon', () => {
  const data = parseIndicators(TEXT, 123);
  assert.equal(data.at, 123);
  assert.deepEqual(data.sections.map(s => s.title), ['Стан по паливу', 'Остання заправка']);
  assert.match(data.sections[1].html, /<a href="https:\/\/t\.me\/SergiiNM"/);
  assert.equal(parseIndicators('', 1), null);
  assert.equal(parseIndicators(TEXT, 'x'), null);
});

test('indicators travel in the snapshot, are kept when a run sends none, and appear only in the report', async () => {
  const data = new Map();
  const DATA = { get: async key => (data.has(key) ? JSON.parse(data.get(key)) : null), put: async (key, value) => data.set(key, value) };
  const env = { DATA, INGEST_SECRET: 's' };
  const NOW = Date.parse('2026-11-13T10:00:00Z');
  const handle = createHandler({ now: () => NOW });
  const post = (path, body) => handle(new Request('https://x' + path, { method: 'POST', headers: { 'X-Ingest-Secret': 's' }, body: JSON.stringify(body) }), env);
  const base = { measuredAt: NOW - 60000, gridStatus: 1 };
  await post('/api/ingest', { schemaVersion: 1, snapshot: { ...base, indicatorsHtml: TEXT, indicatorsAt: NOW } });
  await post('/api/ingest', { schemaVersion: 1, snapshot: { ...base, measuredAt: NOW - 30000 } }); // no indicators this time
  await post('/api/ingest/journal', { schemaVersion: 1, hash: 'j', rows: [] });

  const status = await (await handle(new Request('https://x/api/status'), env)).text();
  assert.ok(!status.includes('Sergii') && !status.includes('indicators'));
  const report = await (await handle(new Request('https://x/api/generator-report?from=2026-11-13&to=2026-11-13'), env)).json();
  assert.equal(report.indicators.sections.length, 2);
  assert.equal(report.indicators.at, NOW);
});
