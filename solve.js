// sitegen-speed: a fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build returns for the same input, byte for byte,
// but computed with a fused single-pass Markdown renderer, an index-based inline parser, cached slug/date lookups and
// templates compiled to JavaScript functions. No dependencies; all state is per call, so cases never share caches.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML replacement for each escapable code unit (below 256), null elsewhere: one table for every escaper. */
const ESC_REP = new Array(256).fill(null);
ESC_REP[38] = '&amp;';
ESC_REP[60] = '&lt;';
ESC_REP[62] = '&gt;';
ESC_REP[34] = '&quot;';
ESC_REP[39] = '&#39;';

/** `text` with & < > " and ' escaped, and nothing else; the same string back when there is nothing to escape. */
function escapeHtml(s) {
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const rep = code < 256 ? ESC_REP[code] : null;
    if (rep === null) continue;
    out = (out === null ? s.slice(0, i) : out + s.slice(last, i)) + rep;
    last = i + 1;
  }
  return out === null ? s : out + s.slice(last);
}

const SLUG_MAX = 64;

/** The slug of `text`, makefun-site's rule: NFKD, marks dropped, lowered, non [a-z0-9] runs one "-", cut at 64. */
function slugifyUncached(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  // Maximal runs of [A-Za-z0-9], lowered as one slice each and joined by single dashes: the same slug as the
  // character-at-a-time rule (a run boundary is exactly where that rule's gap flag would fire).
  let out = '';
  let started = false;
  let i = 0;
  const n = plain.length;
  while (i < n) {
    while (i < n) {
      const c = plain.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) break;
      i++;
    }
    if (i >= n) break;
    let j = i + 1;
    while (j < n) {
      const c = plain.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (started) out += '-';
    out += plain.slice(i, j).toLowerCase();
    started = true;
    i = j;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDateUncached(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether `code` (a UTF-16 code unit at or above 256) is JavaScript whitespace, as \s sees it. */
function isWsBig(code) {
  return (
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}

/** Whitespace lookup for code units below 256 (the \s set: \t-\r, space, U+00A0). */
const WS_LOW = new Uint8Array(256);
for (const c of [9, 10, 11, 12, 13, 32, 160]) WS_LOW[c] = 1;

/** Whether `code` (a UTF-16 code unit) is JavaScript whitespace, as \s sees it. */
function isWsCode(code) {
  return code < 256 ? WS_LOW[code] === 1 : isWsBig(code);
}

/** A whitespace run that a word follows: one per word, except a word starting at the very first character. */
const WS_RUN_BEFORE_WORD = /\s+(?=\S)/g;

/**
 * The words of a body: its runs of characters other than whitespace. The whitespace set above is exactly
 * JavaScript's \s, so the count is the whitespace runs a word follows, plus one for a word at the start —
 * the same count as walking the string and noting each run's first character, at regex-engine speed.
 */
function wordsOf(text) {
  if (text.length === 0) return 0;
  const runs = text.match(WS_RUN_BEFORE_WORD);
  let count = runs === null ? 0 : runs.length;
  const c0 = text.charCodeAt(0);
  if (!(c0 < 256 ? WS_LOW[c0] === 1 : isWsBig(c0))) count++;
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmStringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. Only the lines up to the closing "---" are scanned; the body is one slice.
 */
function parseFrontMatter(text) {
  const n = text.length;
  const eol = text.indexOf('\n');
  if ((eol === -1 ? text : text.slice(0, eol)) !== '---') return { error: 'no front matter' };
  if (eol === -1) return { error: 'the front matter is not closed' };
  const fmLines = [];
  let bodyStart = -1;
  let pos = eol + 1;
  while (pos <= n) {
    const next = text.indexOf('\n', pos);
    const lineEnd = next === -1 ? n : next;
    if (lineEnd - pos === 3 && text.startsWith('---', pos)) {
      bodyStart = next === -1 ? n : next + 1;
      break;
    }
    fmLines.push(text.slice(pos, lineEnd));
    if (next === -1) break;
    pos = next + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let k = 0; k < fmLines.length; k++) {
    const line = fmLines[k];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown: inline

/** The characters a backslash escapes, by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

/** The first index in [from, end) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Inline plain-run classes, by code unit below 256: 1 breaks the run (\\ ` * [), 2 escapes in place, 0 is plain. */
const INLINE_CLS = new Uint8Array(256);
for (const ch of ['\\', '`', '*', '[']) INLINE_CLS[ch.charCodeAt(0)] = 1;
for (let code = 0; code < 256; code++) if (ESC_REP[code] !== null) INLINE_CLS[code] = 2;

/**
 * `s[a..b]` rendered inline into `out` (an array of chunks); `env.link(target)` is a link's href. Mirrors
 * makefun-site's inline() exactly, over ranges of the original string instead of slices.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash
      if (i + 1 < b && isEscapable(s.charCodeAt(i + 1))) {
        out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === 96) {
      // backtick
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === 42) {
      // *
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    if (c === 91) {
      // [
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
        const p = s.indexOf(')', k + 2);
        if (p !== -1 && p < b) m = p;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        continue;
      }
      out.push('[');
      i++;
      continue;
    }
    // A plain run: everything up to the next \\ ` * or [, with the five HTML escapes applied on the way.
    let seg = i;
    while (i < b) {
      const code = s.charCodeAt(i);
      const cls = code < 256 ? INLINE_CLS[code] : 0;
      if (cls === 0) {
        i++;
        continue;
      }
      if (cls === 1) break;
      if (seg < i) out.push(s.slice(seg, i));
      out.push(ESC_REP[code]);
      i++;
      seg = i;
    }
    if (seg < i) out.push(s.slice(seg, i));
  }
}

/** `s` rendered inline, as one string. */
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

// ---------------------------------------------------------------- markdown: blocks

const RE_BLANK = /^[ \t]*$/;
const RE_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const RE_FENCE_CLOSE = /^```[ \t]*$/;
const RE_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RE_HR = /^(?:---|\*\*\*)[ \t]*$/;
const RE_BULLET = /^[-*] (.*)$/;
const RE_ORDERED = /^(\d{1,9})\. (.*)$/;
const RE_CONTINUED = /^ {2,}\S/;

/** Whether every character of `line` is a space or tab (a blank line). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-opening line's language, or null: three backticks, language characters, spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, spaces/tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. Mirrors RE_HEADING + the empty-text refusal. */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  if (h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let start = h;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return { depth: h, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: --- or ***, spaces/tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if ((c !== 45 && c !== 42) || line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* " and the rest of the line. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's { num, text }, or null: 1-9 digits, ". ", the rest of the line. */
function orderedText(line) {
  let i = 0;
  while (i < line.length && i < 10) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isWsCode(line.charCodeAt(i));
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` opens a fence (boolean form of fenceLang, for paragraph continuation checks). */
function isFenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
    i++;
  }
  return true;
}

/** Whether `line` is a heading with text (boolean form of headingOf, for paragraph continuation checks). */
function isHeading(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6 || h >= line.length) return false;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return false;
  for (let i = h; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return true;
  }
  return false;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line, slow) {
  if (slow) return RE_BLANK.test(line) || RE_FENCE_OPEN.test(line) || headingOfRe(line) !== null || RE_HR.test(line);
  return isBlank(line) || isFenceOpen(line) || isHeading(line) || isHr(line);
}

/** headingOf through the reference regex (for lines holding U+2028/U+2029, where "." behaves differently). */
function headingOfRe(line) {
  const m = RE_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings) and its excerpt (the first paragraph's
 * inline HTML, or ""). One pass, lexing and rendering together. `slugify` is the build's cached slug function.
 */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  // Lines holding a line/paragraph separator take the reference's own regex path: "." in its patterns stops there.
  // One scan of the whole body decides whether any line can need it.
  const anySlow = src.includes('\u2028') || src.includes('\u2029');
  const slowOf = (l) => anySlow && (l.includes('\u2028') || l.includes('\u2029'));
  while (i < n) {
    const line = lines[i];
    const slow = slowOf(line);
    if (slow ? RE_BLANK.test(line) : isBlank(line)) {
      i++;
      continue;
    }
    const fence = slow ? (RE_FENCE_OPEN.exec(line)?.[1] ?? null) : fenceLang(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n) {
        const l = lines[i];
        if (slowOf(l) ? RE_FENCE_CLOSE.test(l) : isFenceClose(l)) break;
        body.push(l);
        i++;
      }
      i++;
      const cls = fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`;
      out.push(`<pre><code${cls}>`);
      for (const l of body) out.push(escapeHtml(l), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    const heading = slow ? headingOfRe(line) : headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (slow ? RE_HR.test(line) : isHr(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // >
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
        i++;
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        const text = body.join('\n');
        inlineRange(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = slow ? RE_BULLET.exec(line)?.[1] ?? null : bulletText(line);
    const ordered = bullet === null ? (slow ? RE_ORDERED.exec(line) : orderedText(line)) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? (slow ? Number(ordered[1]) : ordered.num) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const lSlow = slowOf(l);
        let text = null;
        if (isOrdered) {
          if (lSlow) {
            const m = RE_ORDERED.exec(l);
            text = m === null ? null : m[2];
          } else {
            const o = orderedText(l);
            text = o === null ? null : o.text;
          }
        } else {
          text = lSlow ? RE_BULLET.exec(l)?.[1] ?? null : bulletText(l);
        }
        if (text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (lSlow ? RE_CONTINUED.test(l) : isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const parts of items) {
        out.push('<li>');
        const text = parts.join('\n');
        inlineRange(text, 0, text.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i], slowOf(lines[i]))) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inline(text, env);
      excerpt = html;
      out.push(`<p>${html}</p>\n`);
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tplTokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** lookup for a one-name path. */
function lookup1(scope, name) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** lookup for a two-name path. */
function lookup2(scope, a, b) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Node trees compiled to a render function (S, C, D, O, L, T, R, L1, L2) that pushes chunks into O. */
function compileTemplate(nodes) {
  const st = { n: 0 };
  const look = (path) =>
    path.length === 1
      ? `L1(S,${JSON.stringify(path[0])})`
      : path.length === 2
        ? `L2(S,${JSON.stringify(path[0])},${JSON.stringify(path[1])})`
        : `L(S,${JSON.stringify(path)})`;
  const gen = (list) => {
    let code = '';
    for (const nd of list) {
      switch (nd.kind) {
        case 'text':
          code += `O.push(${JSON.stringify(nd.text)});`;
          break;
        case 'var':
          code += `O.push(C.V(${look(nd.path)}));`;
          break;
        case 'raw':
          code += `O.push(T(${look(nd.path)}));`;
          break;
        case 'if': {
          const cond = nd.not ? `!R(${look(nd.path)})` : `R(${look(nd.path)})`;
          code += `if (${cond}) {${gen(nd.then)}}`;
          if (nd.else !== null) code += ` else {${gen(nd.else)}}`;
          break;
        }
        case 'for': {
          const id = ++st.n;
          const xs = `x${id}`;
          const kk = `k${id}`;
          const ln = `l${id}`;
          const pp = `p${id}`;
          code +=
            `{const ${xs}=${look(nd.path)};if(Array.isArray(${xs})){const ${ln}=${xs}.length;const ${pp}=S;` +
            `for(let ${kk}=0;${kk}<${ln};${kk}++){const S={vars:{[${JSON.stringify(nd.name)}]:${xs}[${kk}],loop:{index:${kk}+1,first:${kk}===0,last:${kk}===${ln}-1,length:${ln}}},parent:${pp}};` +
            `${gen(nd.body)}}}}`;
          break;
        }
        case 'include':
          code += `if (D < ${INCLUDE_DEPTH}) { const f = C.tpl.get(${JSON.stringify(nd.name)}); if (f !== undefined) f(S, C, D + 1, O, L, T, R, L1, L2); }`;
          break;
      }
    }
    return code;
  };
  return new Function('S', 'C', 'D', 'O', 'L', 'T', 'R', 'L1', 'L2', gen(nodes));
}

/** Every path segment a template tree names, gathered into `set` (for knowing which page fields any template can read). */
function collectSegments(nodes, set) {
  for (const nd of nodes) {
    if (nd.kind === 'var' || nd.kind === 'raw' || nd.kind === 'for' || nd.kind === 'if') for (const seg of nd.path) set.add(seg);
    if (nd.kind === 'for') collectSegments(nd.body, set);
    else if (nd.kind === 'if') {
      collectSegments(nd.then, set);
      if (nd.else !== null) collectSegments(nd.else, set);
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_FIRST = /[A-Za-z]/;
const SCHEME_REST = /[A-Za-z0-9+.-]/;

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's answer for `input`. */
export function run(input) {
  // Per-build caches: slugs and long dates repeat heavily inside one site.
  const slugCache = new Map();
  const slugify = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugifyUncached(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const dateCache = new Map();
  const longDate = (date) => {
    let v = dateCache.get(date);
    if (v === undefined) {
      v = longDateUncached(date);
      dateCache.set(date, v);
    }
    return v;
  };

  const templates = new Map();
  const report = [];
  const segments = new Set();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      collectSegments(nodes, segments);
      templates.set(name, compileTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // reading_minutes costs a scan of every body; no template path naming it means no render can ever read it.
  const needsMinutes = segments.has('reading_minutes');
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name. A (directory, target)
  // pair resolves the same way from every source in that directory, so resolutions are memoised per build;
  // a broken resolution is cached as null and still reported once per linking source.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  const resolveLink = (dir, target) => {
    const key = `${dir}\n${target}`;
    let href = linkCache.get(key);
    if (href !== undefined) return href;
    href = target;
    const c0 = target.charCodeAt(0);
    if (c0 !== 47 && c0 !== 35) {
      // / and # keep the target; so does one opening on a scheme.
      let scheme = false;
      if (SCHEME_FIRST.test(target[0])) {
        let j = 1;
        while (j < target.length && SCHEME_REST.test(target[j])) j++;
        scheme = target[j] === ':';
      }
      if (!scheme) {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else href = null;
      }
    }
    linkCache.set(key, href);
    return href;
  };
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const href = resolveLink(dir, target);
        if (href === null) {
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return href;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, named as first met in the posts' order, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => {
    if (s === null) return null;
    if (s.link === undefined) s.link = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    return s.link;
  };
  function cardOf(s) {
    if (s.card === undefined) {
      s.card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: needsMinutes ? Math.max(1, Math.ceil(wordsOf(s.body) / 200)) : 0,
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
    }
    return s.card;
  }
  function pageOf(s) {
    return {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // Every page through its layout, the index pages and the tag pages through theirs, then the statics.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  // Template values repeat heavily across pages (the site title, the recent posts, the tags): cache their escaping.
  const escCache = new Map();
  const escCached = (s) => {
    let v = escCache.get(s);
    if (v === undefined) {
      v = escapeHtml(s);
      escCache.set(s, v);
    }
    return v;
  };
  const ctx = { tpl: templates, esc: escCached, V: (v) => escCached(textOf(v)) };
  const output = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out, lookup, textOf, truthy, lookup1, lookup2);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
