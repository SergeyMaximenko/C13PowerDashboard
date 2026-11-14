// Generator indicators: the text the C# application also saves as a note in the "Показники" sheet (Telegram HTML).
// The Worker turns it into safe sections for the report page. Only <b> <i> <u> <blockquote> and links to https://t.me/<name> survive;
// everything else is escaped as plain text.
export const MAX_INDICATORS_CHARS = 20000;

const escapeText = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PLAIN_TAGS = new Set(['b', 'i', 'u', 'blockquote']);
const LINK = /^<a\s+href="https:\/\/t\.me\/([A-Za-z0-9_]{3,64})"(?:\s+target="_blank")?\s*>$/i;

// "<b>x</b> a < b" -> safe HTML. Unknown tags are shown as text, not removed silently.
export function sanitizeHtml(source) {
  let result = '';
  let openLink = false;
  let last = 0;
  for (const match of String(source).matchAll(/<[^<>]*>/g)) {
    result += escapeText(source.slice(last, match.index));
    last = match.index + match[0].length;
    const tag = match[0];
    const name = /^<\/?\s*([a-z0-9]+)/i.exec(tag)?.[1]?.toLowerCase();
    const closing = /^<\//.test(tag);
    if (name && PLAIN_TAGS.has(name) && /^<\/?\s*[a-z]+\s*>$/i.test(tag)) result += closing ? '</' + name + '>' : '<' + name + '>';
    else if (name === 'a' && closing && openLink) { result += '</a>'; openLink = false; }
    else if (name === 'a' && !closing && !openLink && LINK.test(tag)) {
      result += '<a href="https://t.me/' + LINK.exec(tag)[1] + '" target="_blank" rel="noopener noreferrer">';
      openLink = true;
    } else result += escapeText(tag);
  }
  result += escapeText(source.slice(last));
  return openLink ? result + '</a>' : result;
}

const stripTags = html => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// Blocks are separated by a blank line; a block starts with "<b>Title:</b>". The first block ("Показники станом на")
// is dropped: the page shows the calculation time itself (`at`).
export function parseIndicators(source, at) {
  if (typeof source !== 'string' || !source.trim() || source.length > MAX_INDICATORS_CHARS) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const sections = [];
  for (const block of source.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const first = lines[0] ?? '';
    const title = stripTags(sanitizeHtml(first)).replace(/:\s*$/, '');
    if (!title || /^показники станом на/i.test(title)) continue;
    const html = sanitizeHtml(lines.slice(1).join('\n')).trim();
    if (html) sections.push({ title, html });
  }
  return sections.length ? { at, sections } : null;
}
