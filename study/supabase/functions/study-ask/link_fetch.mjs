/* Turning a page the owner chose into passages Ask can answer from.
 *
 * Research mode, external: the owner pastes the links they want an answer to come from, and this
 * is what a link becomes. There is no model anywhere in this file and no model anywhere in the
 * path that uses it: checking the address, pulling the page, taking the readable text out of the
 * HTML and cutting it into passages are all code, so adding a source costs nothing but the
 * bandwidth. What it costs is the tokens of whatever passages a later question actually uses.
 *
 * This is NOT web search. Nothing here looks anything up, follows a link it found in a page, or
 * decides for itself what to read. It fetches exactly the addresses the owner typed, and only
 * those. CLAUDE.md names this as the owner's own decision, alongside the textbook and the source
 * shelf, and under the same rules: the text lives only in study_ai_passages, never in a material
 * and never in the repo, and an answer may quote at most fifteen words of it.
 *
 * Plain ESM with no dependencies and nothing that reads the environment or the network, so the
 * same file loads in the Edge Function under Deno and in link_fetch_test.mjs under Node. The
 * fetch itself stays in index.ts, which is the only place allowed to touch the network.
 *
 * No em dashes and no en dashes in this file.
 */

/* What a link may be. The limits are small on purpose: this is a study hub, and a page that does
   not fit in forty passages is a page the student should be reading rather than asking about. */
export const LINK_LIMITS = {
  url: 2000,
  /* The whole response body. Anything larger is refused rather than truncated, because half a
     document read as if it were the whole one is worse than no document. */
  bytes: 2_000_000,
  /* Seconds of patience for one page. */
  timeoutMs: 12_000,
  redirects: 3,
  passages: 40,
  passageChars: 1500,
  /* What a passage aims for before it is closed on a paragraph boundary. */
  target: 950,
  title: 200,
  links: 12
};

/* The content types this can read. HTML and plain text only: a PDF needs a parser, and a parser
   is a dependency in a function that has none. A PDF link is refused with a reason the owner can
   act on rather than silently producing an empty document. */
export const LINK_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown'];

/* Hostnames that must never be fetched, whatever the owner typed. An Edge Function sits inside
   somebody else's network, so a link is a way to ask it to fetch that network's own addresses.
   Literal IP addresses are refused outright rather than parsed and range checked, because the
   ranges are the part people get wrong, and a study source is never at a bare IP anyway. */
const BAD_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\..*|.*\.home\.arpa)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HEXY = /^[0-9a-f.:]+$/i;

/* An address this may fetch, normalised, or a reason it may not. Called again on every redirect
   hop, because a safe address that redirects to an unsafe one is the whole trick. */
export function checkUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > LINK_LIMITS.url) return { ok: false, error: 'bad_url' };
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { ok: false, error: 'bad_url' };
  }
  /* https only. Plain http would send the owner's choice of reading over the wire in clear, and
     every source worth reading has had https for a decade. */
  if (u.protocol !== 'https:') return { ok: false, error: 'not_https' };
  if (u.username || u.password) return { ok: false, error: 'bad_url' };
  const host = u.hostname.toLowerCase();
  if (!host || host.length > 253) return { ok: false, error: 'bad_url' };
  if (BAD_HOST.test(host)) return { ok: false, error: 'private_host' };
  /* A bracketed v6 address, a bare v4 address, or anything with no dot in it at all. */
  if (u.hostname.startsWith('[') || IPV4.test(host) || (HEXY.test(host) && host.indexOf(':') >= 0)) {
    return { ok: false, error: 'private_host' };
  }
  if (host.indexOf('.') < 0) return { ok: false, error: 'private_host' };
  u.hash = '';
  return { ok: true, url: u.toString(), host };
}

/* Whether the server sent something this can read. */
export function checkType(contentType) {
  const t = String(contentType == null ? '' : contentType).split(';')[0].trim().toLowerCase();
  if (!t) return { ok: true, type: 'text/html' };
  if (LINK_TYPES.indexOf(t) >= 0) return { ok: true, type: t };
  return { ok: false, error: t === 'application/pdf' ? 'pdf' : 'not_text' };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: ', ', mdash: ', ',
  hellip: '...', rsquo: '’', lsquo: '‘', rdquo: '"', ldquo: '"', middot: '.',
  times: 'x', deg: ' degrees', pound: 'GBP', euro: 'EUR', copy: '(c)', reg: '(r)', trade: '(tm)'
};

/* Entities to characters. An en or em dash becomes a comma rather than itself, because this text
   goes into a prompt and then into an answer, and the house rule about dashes is not negotiable
   just because a web page used one. */
export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (m, d) => codePoint(Number(d)))
    .replace(/&([a-z][a-z0-9]{1,9});/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function codePoint(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return '';
  /* The two dashes again, and the characters that break a prompt block. */
  if (n === 0x2013 || n === 0x2014) return ', ';
  if (n < 32 && n !== 9 && n !== 10) return ' ';
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return '';
  }
}

/* A heading is marked in the flattened text with a character no page will contain, so the splitter
   can keep headings with the passage they introduce without a second pass over the HTML. */
const MARK = '';

const DROP = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form', 'nav', 'aside',
  'header', 'footer', 'template', 'select', 'button', 'figure', 'picture', 'video', 'audio'];

/* The readable text of a page, and its title.
 *
 * Deliberately a set of regular expressions and not a parser. A parser is a dependency, and what
 * is wanted here is not a correct DOM but a body of prose: the worst case for this code is that a
 * passage carries a stray menu item into the prompt, which is a cost of a few tokens and is
 * visible to the reader, and the best case is the article. */
export function extract(html, { title: fallbackTitle = '' } = {}) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  const titleRaw =
    (s.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']{1,300})["']/i) || [])[1] ||
    (s.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i) || [])[1] ||
    (s.match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i) || [])[1] || fallbackTitle;

  /* The main content when the page says where it is. A page that marks an article is telling the
     truth about itself far more often than a heuristic would guess. */
  const main = s.match(/<article[^>]*>([\s\S]*?)<\/article>/i) || s.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (main && main[1] && main[1].length > 500) s = main[1];
  else {
    const body = s.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (body && body[1]) s = body[1];
  }

  for (const tag of DROP) {
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ');
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), ' ');
  }
  /* Headings first, so the marker survives the tag strip below. */
  s = s.replace(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi, (m, inner) => '\n' + MARK + strip(inner) + '\n');
  s = s.replace(/<li[^>]*>/gi, '\n- ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|section|article|ul|ol|li|blockquote|h[1-6]|table|dd|dt)\s*>/gi, '\n\n');
  s = strip(s);

  const lines = [];
  for (const raw of s.split('\n')) {
    const line = raw.replace(/[ \t ]+/g, ' ').trim();
    if (!line) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue; }
    lines.push(line);
  }
  /* Runs of very short lines are a menu, a breadcrumb trail or a footer, whatever the tags said.
     Three or more in a row go; one or two stay, because a date line and a byline are worth having
     and a heading is often short. */
  const out = [];
  let run = [];
  const flush = () => { if (run.length && run.length < 3) out.push(...run); run = []; };
  for (const line of lines) {
    const bare = line[0] === MARK ? line.slice(1) : line;
    if (line !== '' && line[0] !== MARK && bare.length < 25 && bare.split(' ').length < 5) { run.push(line); continue; }
    flush();
    out.push(line);
  }
  flush();

  return { title: clip(strip(decodeEntities(titleRaw)).replace(/\s+/g, ' ').trim(), LINK_LIMITS.title), text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function strip(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '));
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 3).replace(/\s+\S*$/, '') + '...' : t;
}

/* The text as passages, each with the heading it sits under.
 *
 * Paragraphs are packed up to about LINK_LIMITS.target characters and then closed, so a passage
 * is a run of whole paragraphs and never half a sentence. A heading closes the passage before it
 * and names the one after it, which is what makes a citation read as a place in a document rather
 * than a number. */
export function passages(text, { title = '', max = LINK_LIMITS.passages } = {}) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return [];
  const out = [];
  let heading = '';
  let buf = [];
  let n = 0;
  const close = () => {
    if (!buf.length) return;
    const t = buf.join('\n\n').trim();
    buf = [];
    if (t.length < 40) return;
    out.push({ heading: clip(heading ? (title ? title + ': ' + heading : heading) : title, LINK_LIMITS.title), body: t.slice(0, LINK_LIMITS.passageChars) });
  };
  for (const para of body.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (p[0] === MARK) {
      close();
      heading = p.slice(1).replace(/\s+/g, ' ').trim();
      continue;
    }
    /* One paragraph longer than a whole passage becomes its own passages, cut on sentences. */
    if (p.length > LINK_LIMITS.passageChars) {
      close();
      let piece = '';
      for (const sentence of p.match(/[^.!?]+[.!?]*\s*/g) || [p]) {
        if (piece.length + sentence.length > LINK_LIMITS.target && piece) { buf.push(piece.trim()); close(); piece = ''; }
        piece += sentence;
      }
      if (piece.trim()) { buf.push(piece.trim()); close(); }
      if (out.length >= max) break;
      continue;
    }
    buf.push(p);
    n = buf.join('\n\n').length;
    if (n >= LINK_LIMITS.target) close();
    if (out.length >= max) break;
  }
  close();
  return out.slice(0, max);
}

/* The heading a link's passage is stored under, which is also what the answer cites. The site is
   in it because "according to the page you saved" is not something a student can check, and
   "britannica.com, the Columbian exchange" is. The site comes first so that everything before the
   first colon names the document, which is what the per source cap counts on. Stored without
   brackets; the question builder puts those on, the same way it does for the class shelf. */
export function linkLabel(host, heading) {
  const h = String(host == null ? '' : host).replace(/^www\./, '');
  const t = String(heading == null ? '' : heading).trim();
  return clip(h + (t ? ' | ' + t : ''), 200);
}

/* What the owner is told when a link cannot be used. Short, plain, and about the page rather than
   about the code. */
export const LINK_ERRORS = {
  bad_url: 'That is not an address I can read.',
  not_https: 'Only https links, so the address is not sent in clear.',
  private_host: 'That address points inside a private network, so it is refused.',
  pdf: 'A PDF cannot be read yet. Paste the page it came from, or the text itself.',
  not_text: 'That link is not a page of text.',
  too_big: 'That page is too large to read.',
  empty: 'Nothing readable came back from that page.',
  unreachable: 'That page did not answer.',
  too_many: 'There are already twelve links. Remove one first.',
  off: 'Pulling links is switched off.'
};
