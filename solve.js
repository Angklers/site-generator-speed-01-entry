// A faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README (its dialect: front matter, template
// language, Markdown subset, slug rule, build report) with the vendor code as
// the reference for exact semantics. The implementation is my own: a
// range-based, single-pass Markdown renderer (no token objects, no per-
// character escaping), an indexOf-driven front-matter scan (no whole-text
// split), and templates compiled to flat instruction lists rendered by an
// explicit loop (no recursive node walk, no per-iteration scope objects).
//
// run(input) returns, for one case's input, the same output tree makefun-site
// returns: a JSON object of every output path -> file text. All state lives
// in one Builder created per run() call, so nothing leaks from one case to
// the next. The build reads no clock, no environment and no randomness.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The HTML escape table. */
const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The characters a backslash escapes in inline Markdown. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Whether a code unit is JavaScript `\s` whitespace (the set /\s/ matches). */
function isWS(code) {
  return code === 32 || (code >= 9 && code <= 13) || code === 0xA0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200A) || code === 0x2028 || code === 0x2029 ||
    code === 0x202F || code === 0x205F || code === 0x3000 || code === 0xFEFF;
}

const isSpaceTab = (code) => code === 32 || code === 9;

/** `text` with & < > " and ' escaped; returned unchanged when it holds none. */
const ESC_FIRST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
function escStr(text) {
  if (!ESC_FIRST.test(text)) return text;
  return text.replace(ESC_ALL, (c) => ENT[c]);
}

/**
 * Escape the range [a, b) of `src` into `out` (an array of string pieces).
 * Returns how many entities were written.
 */
const ESC_RE = /[&<>"']/g;
function escRange(src, a, b, out) {
  ESC_RE.lastIndex = a;
  let start = a;
  let n = 0;
  let m;
  while ((m = ESC_RE.exec(src)) !== null && m.index < b) {
    if (m.index > start) out.push(src.slice(start, m.index));
    out.push(ENT[m[0]]);
    start = m.index + 1;
    n++;
  }
  if (start < b) out.push(src.slice(start, b));
  return n;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Pure-ASCII text takes the native path: lowercased, split on its
 * non-alphanumeric runs. NFKD is the identity on ASCII and ASCII holds no
 * combining marks, so the two paths agree exactly.
 */
const NON_ASCII = /[^\x00-\x7F]/;
const NON_ALNUM = /[^a-z0-9]+/;
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (!NON_ASCII.test(text)) {
    const parts = text.toLowerCase().split(NON_ALNUM);
    let s = '';
    for (const p of parts) {
      if (p === '') continue;
      s = s === '' ? p : `${s}-${p}`;
    }
    out = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    const chunks = [];
    let cur = '';
    for (let i = 0; i < plain.length; i++) {
      const code = plain.charCodeAt(i);
      let k = -1;
      if (code >= 65 && code <= 90) k = code + 32;
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) k = code;
      if (k === -1) {
        if (cur !== '') {
          chunks.push(cur);
          cur = '';
        }
      } else cur += String.fromCharCode(k);
    }
    if (cur !== '') chunks.push(cur);
    out = chunks.join('-').slice(0, SLUG_MAX).replace(/-+$/, '');
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. The
 * exotic whitespace characters are all >= 0xA0, so ASCII text takes the
 * short test and only a non-ASCII code unit pays for the full set. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 || c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  let out = dir;
  let i = 0;
  const n = rel.length;
  while (i < n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg === '..') {
      if (out === '') return null;
      const k = out.lastIndexOf('/');
      out = k === -1 ? '' : out.slice(0, k);
    } else if (seg !== '' && seg !== '.') {
      out = out === '' ? seg : `${out}/${seg}`;
    }
    i = j + 1;
  }
  return out;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `base_url` with its trailing slashes dropped. */
function stripSlashes(base) {
  let e = base.length;
  while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
  return base.slice(0, e);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERROR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    const parts = [];
    const last = raw.length - 1;
    let i = 1;
    while (i < last) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if (i + 1 === last || (n !== '"' && n !== '\\')) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        parts.push(n);
        i += 2;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else {
        parts.push(c);
        i++;
      }
    }
    return { value: parts.join('') };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERROR };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) return { error: DATE_ERROR };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERROR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** The next line of `text` from `p`: { a, b, next } or null when past the end. */
function lineAt(text, p) {
  if (p > text.length) return null;
  let e = text.indexOf('\n', p);
  if (e === -1) e = text.length;
  return { a: p, b: e, next: e === text.length ? text.length + 1 : e + 1 };
}

/** Whether the range [a, b) of `s` holds only spaces and tabs. */
function isBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Scans the header lines in place; the body is
 * one slice, never a split-and-join.
 */
function parseFrontMatter(text) {
  const first = lineAt(text, 0);
  if (first === null || first.b - first.a !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  let close = null;
  for (let L = lineAt(text, first.next); L !== null; L = lineAt(text, L.next)) {
    if (L.b - L.a === 3 && text.charCodeAt(L.a) === 45 && text.charCodeAt(L.a + 1) === 45 && text.charCodeAt(L.a + 2) === 45) {
      close = L;
      break;
    }
  }
  if (close === null) return { error: 'the front matter is not closed' };
  const data = {};
  let p = first.next;
  let lineNo = 1;
  while (p <= text.length) {
    const L = lineAt(text, p);
    if (L === null) break;
    if (L.a === close.a) break;
    const a = L.a;
    const b = L.b;
    if (!isBlank(text, a, b) && text.charCodeAt(a) !== 35) {
      let k = a;
      while (k < b) {
        const c = text.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        k++;
      }
      if (k === a || k >= b || text.charCodeAt(k) !== 58) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = text.slice(a, k);
      let raw;
      if (k + 1 >= b) raw = '';
      else if (text.charCodeAt(k + 1) === 32) {
        let e2 = b;
        while (e2 > k + 2 && isSpaceTab(text.charCodeAt(e2 - 1))) e2--;
        raw = text.slice(k + 2, e2);
      } else return { error: `line ${lineNo + 1} is not "key: value"` };
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = L.next;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = close.b === text.length ? '' : text.slice(close.b + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const isLangChar = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;

/** A fence-open line's language end, or -1 when the line is no fence. */
function fenceOpen(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return -1;
  let i = a + 3;
  while (i < b && isLangChar(s.charCodeAt(i))) i++;
  const langEnd = i;
  while (i < b && isSpaceTab(s.charCodeAt(i))) i++;
  return i === b ? langEnd : -1;
}

function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  let i = a + 3;
  while (i < b && isSpaceTab(s.charCodeAt(i))) i++;
  return i === b;
}

/** A heading line's { depth, text }, or null. */
function headingOf(s, a, b) {
  let k = 0;
  while (k < 6 && a + k < b && s.charCodeAt(a + k) === 35) k++;
  if (k === 0 || a + k >= b) return null;
  if (!isSpaceTab(s.charCodeAt(a + k))) return null;
  let t = a + k;
  while (t < b && isSpaceTab(s.charCodeAt(t))) t++;
  let e = b;
  while (e > t && isSpaceTab(s.charCodeAt(e - 1))) e--;
  if (t >= e) return null;
  return { depth: k, text: s.slice(t, e) };
}

function isHr(s, a, b) {
  if (b - a < 3) return false;
  const c = s.charCodeAt(a);
  if (c !== 45 && c !== 42) return false;
  if (s.charCodeAt(a + 1) !== c || s.charCodeAt(a + 2) !== c) return false;
  let i = a + 3;
  while (i < b && isSpaceTab(s.charCodeAt(i))) i++;
  return i === b;
}

/** A bullet item's text start, or -1. */
function bulletAt(s, a, b) {
  if (b - a < 2) return -1;
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && s.charCodeAt(a + 1) === 32) return a + 2;
  return -1;
}

/** An ordered item's { start, text }, or null. */
function orderedAt(s, a, b) {
  let i = a;
  let n = 0;
  while (n < 9 && i < b && isDigit(s.charCodeAt(i))) {
    i++;
    n++;
  }
  if (n === 0 || i + 1 >= b) return null;
  if (s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(s.slice(a, i)), text: i + 2 };
}

/** Whether the line continues a list item: two or more spaces, then a non-space. */
function isContinued(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 32) i++;
  if (i - a < 2 || i >= b) return false;
  return !isWS(s.charCodeAt(i));
}

/** Whether a line ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(s, a, b) {
  return isBlank(s, a, b) || fenceOpen(s, a, b) !== -1 || headingOf(s, a, b) !== null || isHr(s, a, b);
}

const trimStart = (s, a, b) => {
  while (a < b && isSpaceTab(s.charCodeAt(a))) a++;
  return a;
};
const trimEnd = (s, a, b) => {
  while (b > a && isSpaceTab(s.charCodeAt(b - 1))) b--;
  return b;
};

/** Whether the run of backslashes just before `j` (within [from, j)) is odd: then the char at `j` is escaped. */
function escapedBefore(s, from, j) {
  let n = 0;
  for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
  return (n & 1) === 1;
}

/** The first unescaped `**` at or after `from` (both stars inside [from, end)), or -1. */
function findStrong(s, from, end) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j < end - 1) {
    if (!escapedBefore(s, from, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** The first single `*` at or after `from` (one whose run is not `**`), outside an escape, or -1. */
function findEm(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (escapedBefore(s, from, j)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (j + 1 < end && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The first unescaped `]` at or after `from` (inside [from, end)), or -1. */
function findBracket(s, from, end) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < end) {
    if (!escapedBefore(s, from, j)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** Whether `s` holds any whitespace character. */
function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/**
 * `s[a..b)` rendered inline, appended as pieces to `out`. `link` resolves a
 * link target to its href. One native scan jumps from one special character
 * to the next; the plain run between two specials is sliced whole (it holds
 * no escapable character), so no character is ever escaped one by one. The
 * shared scan regex is re-aimed before every step, so the recursion into
 * strong, emphasis and link text cannot disturb the caller's scan.
 */
const SPECIAL_RE = /[&<>"'`*\\\[\]]/g;
function inlineInto(s, a, b, link, out) {
  let run = a;
  let pos = a;
  for (;;) {
    SPECIAL_RE.lastIndex = pos;
    const m = SPECIAL_RE.exec(s);
    if (m === null || m.index >= b) break;
    const i = m.index;
    if (i > run) out.push(s.slice(run, i));
    run = i;
    const ch = s[i];
    if (ch === '&') { out.push('&amp;'); pos = run = i + 1; }
    else if (ch === '<') { out.push('&lt;'); pos = run = i + 1; }
    else if (ch === '>') { out.push('&gt;'); pos = run = i + 1; }
    else if (ch === '"') { out.push('&quot;'); pos = run = i + 1; }
    else if (ch === "'") { out.push('&#39;'); pos = run = i + 1; }
    else if (ch === '\\') {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        const e = s[i + 1];
        out.push(ENT[e] === undefined ? e : ENT[e]);
        pos = run = i + 2;
      } else pos = i + 1;
    } else if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>');
        escRange(s, i + 1, j, out);
        out.push('</code>');
        pos = run = j + 1;
      } else pos = i + 1;
    } else if (ch === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findStrong(s, i + 2, b);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineInto(s, i + 2, j, link, out);
          out.push('</strong>');
          pos = run = j + 2;
        } else pos = i + 2;
      } else {
        const j = findEm(s, i + 1, b);
        if (j !== -1 && j > i + 1) {
          out.push('<em>');
          inlineInto(s, i + 1, j, link, out);
          out.push('</em>');
          pos = run = j + 1;
        } else pos = i + 1;
      }
    } else if (ch === '[') {
      const k = findBracket(s, i + 1, b);
      let m2 = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') m2 = s.indexOf(')', k + 2);
      if (m2 !== -1 && m2 < b) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !hasWS(target)) {
          out.push('<a href="');
          const href = link(target);
          escRange(href, 0, href.length, out);
          out.push('">');
          inlineInto(s, i + 1, k, link, out);
          out.push('</a>');
          pos = run = m2 + 1;
          continue;
        }
      }
      pos = i + 1;
    } else pos = i + 1;
  }
  if (b > run) out.push(s.slice(run, b));
}

/** `s` rendered inline as one string. One scratch array, reused: rendering
 * is never re-entrant here (inline text never renders more inline text). */
const INLINE_OUT = [];
function inlineStr(s, link) {
  INLINE_OUT.length = 0;
  inlineInto(s, 0, s.length, link, INLINE_OUT);
  return INLINE_OUT.join('');
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's HTML, or ""). One pass over the
 * body's lines; blocks are rendered straight into the output pieces.
 */
function renderMarkdown(src, link, slugCache) {
  const len = src.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let pos = 0;
  while (pos <= len) {
    let b = src.indexOf('\n', pos);
    if (b === -1) b = len;
    const a = pos;
    const next = b === len ? len + 1 : b + 1;
    if (isBlank(src, a, b)) {
      pos = next;
      continue;
    }
    const langEnd = fenceOpen(src, a, b);
    if (langEnd !== -1) {
      const lang = src.slice(a + 3, langEnd);
      out.push('<pre><code', lang === '' ? '' : ` class="language-${escStr(lang)}"`, '>');
      pos = next;
      while (pos <= len) {
        let b2 = src.indexOf('\n', pos);
        if (b2 === -1) b2 = len;
        if (fenceClose(src, pos, b2)) {
          pos = b2 === len ? len + 1 : b2 + 1;
          break;
        }
        escRange(src, pos, b2, out);
        out.push('\n');
        pos = b2 === len ? len + 1 : b2 + 1;
      }
      out.push('</code></pre>', '\n');
      continue;
    }
    const hd = headingOf(src, a, b);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inlineStr(hd.text, link);
      out.push(`<h${hd.depth} id="${id}">`, html, `</h${hd.depth}>`, '\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = next;
      continue;
    }
    if (isHr(src, a, b)) {
      out.push('<hr>', '\n');
      pos = next;
      continue;
    }
    if (src.charCodeAt(a) === 62) {
      const parts = [];
      while (pos <= len) {
        let b2 = src.indexOf('\n', pos);
        if (b2 === -1) b2 = len;
        if (src.charCodeAt(pos) !== 62) break;
        let s2 = pos + 1;
        if (s2 < b2 && src.charCodeAt(s2) === 32) s2++;
        const ta = trimStart(src, s2, b2);
        const tb = trimEnd(src, ta, b2);
        if (ta < tb) parts.push(src.slice(ta, tb));
        pos = b2 === len ? len + 1 : b2 + 1;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else out.push('<blockquote>\n<p>', inlineStr(parts.join('\n'), link), '</p>\n</blockquote>', '\n');
      continue;
    }
    const bl = bulletAt(src, a, b);
    const od = bl === -1 ? orderedAt(src, a, b) : null;
    if (bl !== -1 || od !== null) {
      const isOrdered = od !== null;
      const start = isOrdered ? od.start : 1;
      const items = [];
      const ta0 = trimStart(src, isOrdered ? od.text : bl, b);
      const tb0 = trimEnd(src, ta0, b);
      items.push([src.slice(ta0, tb0)]);
      pos = next;
      while (pos <= len) {
        let b2 = src.indexOf('\n', pos);
        if (b2 === -1) b2 = len;
        const a2 = pos;
        let done = false;
        if (isOrdered) {
          const m2 = orderedAt(src, a2, b2);
          if (m2 !== null) {
            const ta = trimStart(src, m2.text, b2);
            const tb = trimEnd(src, ta, b2);
            items.push([src.slice(ta, tb)]);
            pos = b2 === len ? len + 1 : b2 + 1;
            done = true;
          }
        } else {
          const m2 = bulletAt(src, a2, b2);
          if (m2 !== -1) {
            const ta = trimStart(src, m2, b2);
            const tb = trimEnd(src, ta, b2);
            items.push([src.slice(ta, tb)]);
            pos = b2 === len ? len + 1 : b2 + 1;
            done = true;
          }
        }
        if (done) continue;
        if (isContinued(src, a2, b2)) {
          const ta = trimStart(src, a2, b2);
          const tb = trimEnd(src, ta, b2);
          items[items.length - 1].push(src.slice(ta, tb));
          pos = b2 === len ? len + 1 : b2 + 1;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const parts of items) out.push('<li>', inlineStr(parts.join('\n'), link), '</li>\n');
      out.push(`</${tag}>`, '\n');
      continue;
    }
    const parts = [];
    {
      const ta = trimStart(src, a, b);
      const tb = trimEnd(src, ta, b);
      parts.push(src.slice(ta, tb));
    }
    pos = next;
    while (pos <= len) {
      let b2 = src.indexOf('\n', pos);
      if (b2 === -1) b2 = len;
      if (endsParagraph(src, pos, b2)) break;
      const ta = trimStart(src, pos, b2);
      const tb = trimEnd(src, ta, b2);
      parts.push(src.slice(ta, tb));
      pos = b2 === len ? len + 1 : b2 + 1;
    }
    const html = inlineStr(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>', '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether the range [a, b) of `s` holds only spaces and tabs. */
function isSpaces(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Operation codes in a compiled template:
//   0 text        [0, text]
//   1 var/raw     [1, path, raw]
//   2 for         [2, name, path, endforIndex]
//   3 endfor      [3]
//   4 if          [4, path, not, elseIndex(-1), endifIndex]
//   5 else        [5, endifIndex]
//   6 endif       [6]
//   7 include     [7, name]

/** `src` compiled into its flat operation list (a TemplateError when it does not parse). */
function compileTemplate(name, src) {
  const ops = [];
  const stack = [];
  let lit = '';
  let i = 0;
  const flush = () => {
    if (lit !== '') {
      ops.push([0, lit]);
      lit = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      lit += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      lit += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    lit += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flush();
      ops.push([1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()), raw]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaces(src, lineStart, open) && isSpaces(src, end, lineEnd);
    if (standalone) lit = lit.slice(0, lit.length - (open - lineStart));
    flush();
    const tag = src.slice(open + 2, close).trim();
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      ops.push([2, m[1], pathOf(name, m[2]), -1]);
      stack.push({ kind: 'for', index: ops.length - 1 });
    } else if ((m = IF_RE.exec(tag)) !== null) {
      ops.push([4, pathOf(name, m[2]), m[1] !== undefined, -1, -1]);
      stack.push({ kind: 'if', index: ops.length - 1, elseIndex: -1 });
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top === undefined || top.kind !== 'if' || top.elseIndex !== -1) throw new TemplateError(`template "${name}": an else outside an if`);
      ops.push([5, -1]);
      top.elseIndex = ops.length - 1;
      ops[top.index][3] = top.elseIndex;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      const top = stack[stack.length - 1];
      if (top === undefined || top.kind !== want) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      if (want === 'for') {
        ops[top.index][3] = ops.length;
        ops.push([3]);
      } else {
        ops[top.index][4] = ops.length;
        if (top.elseIndex !== -1) ops[top.elseIndex][1] = ops.length;
        ops.push([6]);
      }
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      ops.push([7, m[1]]);
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  flush();
  if (stack.length > 0) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return ops;
}

/** The value at `path` in the scope frames (innermost first), or undefined. */
function lookup(frames, path) {
  const first = path[0];
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += textOf(v[k]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const INCLUDE_DEPTH = 8;

// ---------------------------------------------------------------- the build

/** One case's build. All state is per-instance: a run() call makes a fresh Builder. */
class Builder {
  constructor(input) {
    this.input = input;
    this.base = stripSlashes(input.site.base_url);
    this.report = [];
    this.broken = new Set();
    this.slugCache = new Map();
    this.templates = new Map();
    for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
      try {
        this.templates.set(name, compileTemplate(name, input.templates[name]));
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        this.report.push(err.message);
      }
    }
    this.sources = [];
    this.statics = [];
    this.bySource = new Map();
    this.posts = [];
    this.tags = [];
    this.output = {};
  }

  run() {
    this.readSources();
    this.frontMatter();
    this.permalinks();
    this.markdown();
    this.collections();
    this.tagsStep();
    this.layouts();
    this.reportStep();
    return this.output;
  }

  /** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
  readSources() {
    const files = [...this.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) {
        this.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
      } else this.statics.push({ path: f.path, content: f.content });
    }
  }

  /** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
  frontMatter() {
    const kept = [];
    for (const s of this.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        this.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own = undefined;
      for (const d of RESERVED) {
        if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
          own = d;
          break;
        }
      }
      if (own !== undefined) {
        this.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        this.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!this.templates.has(layout)) {
        this.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        this.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    this.sources = kept;
  }

  /** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
  permalinks() {
    const taken = new Map();
    for (const s of this.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, this.slugCache), set);
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${this.base}/${s.outDir}/`;
      this.bySource.set(s.path, s);
    }
  }

  /** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
  markdown() {
    const staticPaths = new Set(this.statics.map((f) => f.path));
    const bySource = this.bySource;
    const base = this.base;
    const broken = this.broken;
    for (const s of this.sources) {
      const dir = dirOf(s.path);
      const spath = s.path;
      const link = (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, link, this.slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  /** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
  collections() {
    const posts = this.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    this.posts = posts;
    for (let k = 0; k < posts.length; k++) {
      posts[k].newer = k === 0 ? null : posts[k - 1];
      posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
    }
  }

  /** 6. The tags, grouped by their slug, ordered by count and then slug. */
  tagsStep() {
    const bySlug = new Map();
    const cache = this.slugCache;
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name, cache);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of this.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, cache);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: `${this.base}/tags/${slug}/`, posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of this.sources) {
      if (s.post) continue;
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, cache);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
    this.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  /** A page's link record as templates read it. */
  linkOf(s) {
    if (s === null) return null;
    return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  }

  /** A post's card, as lists show it. `reading_minutes` is computed lazily:
   * only the card and post layouts read it, so a page whose layout never
   * asks for it never pays the word count. The value is cached on first
   * read, so repeated renders of one card count its body once. */
  cardOf(s) {
    let rm = 0;
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      get reading_minutes() {
        if (rm === 0) rm = Math.max(1, Math.ceil(countWords(s.body) / 200));
        return rm;
      },
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }

  /** Render a template's ops in `frames`, appending pieces to `out`. */
  renderOps(ops, frames, out, depth) {
    let pc = 0;
    while (pc < ops.length) {
      const op = ops[pc];
      switch (op[0]) {
        case 0:
          out.push(op[1]);
          pc++;
          break;
        case 1: {
          const v = lookup(frames, op[1]);
          let t;
          if (typeof v === 'string') t = v;
          else if (typeof v === 'number' || typeof v === 'boolean') t = String(v);
          else if (Array.isArray(v)) t = textOf(v);
          else t = '';
          out.push(op[2] ? t : escStr(t));
          pc++;
          break;
        }
        case 2: {
          const xs = lookup(frames, op[2]);
          if (!Array.isArray(xs) || xs.length === 0) {
            pc = op[3] + 1;
            break;
          }
          const frame = {};
          const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
          frame[op[1]] = xs[0];
          frame.loop = loop;
          frame.$arr = xs;
          frame.$i = 0;
          frame.$name = op[1];
          frame.$loop = loop;
          frame.$start = pc + 1;
          frame.$end = op[3];
          frames.push(frame);
          pc++;
          break;
        }
        case 3: {
          const F = frames[frames.length - 1];
          const ni = F.$i + 1;
          if (ni < F.$arr.length) {
            F.$i = ni;
            F[F.$name] = F.$arr[ni];
            F.loop = F.$loop;
            const lp = F.$loop;
            lp.index = ni + 1;
            lp.first = ni === 0;
            lp.last = ni === F.$arr.length - 1;
            pc = F.$start;
          } else {
            frames.pop();
            pc++;
          }
          break;
        }
        case 4: {
          const v = lookup(frames, op[1]);
          const tv = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
          pc = tv !== op[2] ? pc + 1 : (op[3] === -1 ? op[4] : op[3]) + 1;
          break;
        }
        case 5:
          pc = op[1] + 1;
          break;
        case 6:
          pc++;
          break;
        case 7: {
          const t = this.templates.get(op[1]);
          if (t !== undefined && depth < INCLUDE_DEPTH) this.renderOps(t, frames, out, depth + 1);
          pc++;
          break;
        }
      }
    }
  }

  /** 7. Every page through its layout, the index pages and the tag pages through theirs. */
  layouts() {
    const cards = new Map();
    for (const p of this.posts) cards.set(p, this.cardOf(p));
    const site = { title: this.input.site.title, base_url: this.base };
    const allTags = this.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = this.posts.slice(0, this.input.site.recent).map((p) => cards.get(p));
    const b = this;
    // One top frame, one frame stack and one output array, reused by every
    // render: a render only ever reads the frame while it runs, so the
    // per-render vars are assigned in place (a key left unset is undefined,
    // which reads exactly as a missing key).
    const topFrame = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
    const frames = [topFrame];
    const out = [];
    const render = (name, vars) => {
      const ops = b.templates.get(name);
      if (ops === undefined) return null;
      topFrame.page = vars.page;
      topFrame.posts = vars.posts;
      topFrame.pager = vars.pager;
      topFrame.tag = vars.tag;
      out.length = 0;
      b.renderOps(ops, frames, out, 0);
      return out.join('');
    };
    for (const s of this.sources) {
      const p = s.post ? cards.get(s) : this.cardOf(s);
      const page = {
        title: p.title,
        url: p.url,
        date: p.date,
        date_long: p.date_long,
        summary: p.summary,
        excerpt: p.excerpt,
        get reading_minutes() {
          return p.reading_minutes;
        },
        tags: p.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc,
        newer: this.linkOf(s.newer ?? null),
        older: this.linkOf(s.older ?? null),
        is_post: s.post,
      };
      this.output[`${s.outDir}/index.html`] = render(s.layout, { page });
    }
    const per = this.input.site.per_page;
    const pages = Math.max(1, Math.ceil(this.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${this.base}/` : `${this.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: this.posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) this.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of this.tags) {
      const html = render('tag', {
        tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
      });
      if (html !== null) this.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) this.output['tags/index.html'] = tagsHtml;
    for (const f of this.statics) {
      if (Object.hasOwn(this.output, f.path)) this.report.push(`shadowed ${f.path}: a built page has its path`);
      else this.output[f.path] = f.content;
    }
  }

  /** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
  reportStep() {
    const lines = [...this.report, ...this.broken].sort(byCodeUnits);
    let pages = 0;
    for (const s of this.sources) if (!s.post) pages++;
    lines.push(`built ${pages} pages, ${this.posts.length} posts, ${this.tags.length} tags and ${this.statics.length} static files`);
    this.output['build-report.txt'] = `${lines.join('\n')}\n`;
  }
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  if (target.length === 0) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return new Builder(input).run();
}
