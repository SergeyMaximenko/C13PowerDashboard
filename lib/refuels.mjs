import { parseTime } from './domain.mjs';
import { localText } from './generator.mjs';

// Minimal CSV reader (Google Sheets "Publish to the web" format): quoted fields, "" escapes, line breaks inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(cell => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some(cell => cell.trim() !== '')) rows.push(row);
  return rows;
}

const norm = value => String(value ?? '').replace(/[\s ​]+/g, ' ').trim().toLowerCase();
const TRUE_VALUES = new Set(['так', 'yes', 'true', '1', '+', 'x', 'y', 'да', '✓']);
const isFlag = value => TRUE_VALUES.has(norm(value));

// "2026-11-06 9:05:07", "2026-11-06 21:10", "06.11.2026 21:10" (Kyiv time) -> milliseconds, otherwise null.
export function parseRefuelTime(value) {
  const raw = String(value ?? '').trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  let year, month, day, hour, minute, second;
  if (m) [, year, month, day, hour, minute, second] = m;
  else {
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
    if (!m) return null;
    [, day, month, year, hour, minute, second] = m;
  }
  const two = n => String(n ?? '0').padStart(2, '0');
  return parseTime(year + '-' + two(month) + '-' + two(day) + ' ' + two(hour) + ':' + minute + ':' + two(second));
}

function number(value) {
  const text = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

// Refuels from the sheet: the moment is taken from "Дата заправки" (not from the logging time "Дата події").
// Rows marked as a test ("Режим тесту") or as excluded ("Не враховувати …") are skipped, as well as rows without a valid time.
export function parseRefuels(text) {
  const rows = parseCsv(text);
  const isAtHeader = cell => norm(cell).startsWith('дата заправки');
  const headerIndex = rows.findIndex(row => row.some(isAtHeader));
  if (headerIndex < 0) {
    // Only the column names of the first row are shown (to see which sheet is published), never other data.
    const names = (rows[0] ?? []).slice(0, 12).map(cell => String(cell).replace(/\s+/g, ' ').trim().slice(0, 30)).join(' | ');
    throw new Error('У таблиці не знайдено колонку "Дата заправки". Перший рядок: ' + (names || '(порожньо)'));
  }
  const header = rows[headerIndex].map(norm);
  const column = predicate => header.findIndex(predicate);
  const atColumn = column(h => h.startsWith('дата заправки'));
  const litersColumn = column(h => h === 'літри' || h === 'литры' || h === 'liters');
  const testColumn = column(h => h.startsWith('режим тест'));
  const ignoreColumn = column(h => h.startsWith('не враховувати'));
  // Who refuelled: the user's name ("Користувач Ім'я"), else the user's login ("Користувач Код"). Telegram IDs are never exposed.
  const nameColumn = column(h => h.startsWith('користувач ім'));
  const loginColumn = column(h => h.startsWith('користувач код'));
  const person = row => {
    for (const index of [nameColumn, loginColumn]) {
      // NFKC turns decorative letters (𝕰𝖛𝖌𝖊𝖓𝖎𝖞) into plain ones.
      const text = index >= 0 ? String(row[index] ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
      if (text) return text;
    }
    return null;
  };
  const refuels = [];
  for (const row of rows.slice(headerIndex + 1)) {
    if (testColumn >= 0 && isFlag(row[testColumn])) continue;
    if (ignoreColumn >= 0 && isFlag(row[ignoreColumn])) continue;
    const at = parseRefuelTime(row[atColumn]);
    if (at === null) continue;
    refuels.push({ at, atLocal: localText(at), liters: litersColumn >= 0 ? number(row[litersColumn]) : null, by: person(row) });
  }
  return refuels.sort((a, b) => a.at - b.at);
}
