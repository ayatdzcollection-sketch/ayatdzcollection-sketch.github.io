/* The link reader, checked against the shapes real pages come in. No network and no model: every
   function here is pure, which is the point of keeping the fetch itself in index.ts.
   Run: node link_fetch_test.mjs                                  No em dashes and no en dashes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LINK_LIMITS, LINK_TYPES, LINK_ERRORS, checkUrl, checkType, decodeEntities, extract, passages, linkLabel } from './link_fetch.mjs';

const DASH = /[–—]/;

/* ---------------------------------------------------------------- the address */
for (const good of [
  'https://www.britannica.com/topic/Columbian-exchange',
  'https://en.wikipedia.org/wiki/Pennsylvania?x=1',
  'https://example.co.uk/a/b/c'
]) {
  const r = checkUrl(good);
  assert.ok(r.ok, good + ' should be allowed');
  assert.ok(r.host && r.host.indexOf('.') > 0);
}
/* The fragment is dropped: it is a place on the page, and this reads the whole page. */
assert.equal(checkUrl('https://example.com/a#part').url, 'https://example.com/a');

for (const [bad, why] of [
  ['http://example.com', 'not_https'],
  ['ftp://example.com', 'not_https'],
  ['file:///etc/passwd', 'not_https'],
  ['https://user:pw@example.com', 'bad_url'],
  ['https://localhost/x', 'private_host'],
  ['https://LOCALHOST/x', 'private_host'],
  ['https://printer.local/x', 'private_host'],
  ['https://thing.internal/x', 'private_host'],
  ['https://metadata.google.internal/computeMetadata/v1/', 'private_host'],
  ['https://127.0.0.1/x', 'private_host'],
  ['https://169.254.169.254/latest/meta-data/', 'private_host'],
  ['https://10.0.0.5/x', 'private_host'],
  ['https://[::1]/x', 'private_host'],
  ['https://supabase/x', 'private_host'],
  ['', 'bad_url'],
  ['not a url', 'bad_url'],
  ['https://example.com/' + 'a'.repeat(3000), 'bad_url']
]) {
  const r = checkUrl(bad);
  assert.equal(r.ok, false, bad + ' must be refused');
  assert.equal(r.error, why, bad + ' refused for the wrong reason: ' + r.error);
}
/* Every refusal has something to say to the owner. */
for (const key of ['bad_url', 'not_https', 'private_host', 'pdf', 'not_text', 'too_big', 'empty', 'unreachable', 'too_many', 'off']) {
  assert.ok(LINK_ERRORS[key] && LINK_ERRORS[key].length > 10, 'no message for ' + key);
  assert.ok(!DASH.test(LINK_ERRORS[key]), 'dash in the message for ' + key);
}

/* ---------------------------------------------------------------- the content type */
assert.equal(checkType('text/html; charset=utf-8').ok, true);
assert.equal(checkType('TEXT/HTML').ok, true);
assert.equal(checkType('').ok, true, 'a server that says nothing is given the benefit of the doubt');
assert.equal(checkType('application/pdf').error, 'pdf');
assert.equal(checkType('image/png').error, 'not_text');
assert.equal(checkType('application/json').error, 'not_text');
assert.ok(LINK_TYPES.indexOf('text/html') >= 0);

/* ---------------------------------------------------------------- entities */
assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
/* The two dashes become commas wherever they come from, because the answer must not carry one. */
assert.equal(decodeEntities('1491&ndash;1754'), '1491, 1754');
assert.equal(decodeEntities('a &mdash; b'), 'a ,  b');
assert.equal(decodeEntities('&#8212;'), ', ');
assert.equal(decodeEntities('&nosuchthing;'), '&nosuchthing;', 'an entity it does not know is left alone');

/* ---------------------------------------------------------------- a page */
const PAGE = `<!doctype html>
<html><head>
  <title>The Columbian exchange | Britannica</title>
  <meta property="og:title" content="Columbian exchange">
  <style>body{color:red}</style>
  <script>var tracker = 1; document.write("<p>not text</p>");</script>
</head>
<body>
  <nav><a href="/">Home</a><a href="/a">Topics</a><a href="/b">Quizzes</a><a href="/c">More</a></nav>
  <header><span>Britannica</span></header>
  <main>
    <h1>Columbian exchange</h1>
    <p>The Columbian exchange was the transfer of plants, animals, people and diseases between the
       Americas and the rest of the world after 1492. It reshaped diets on every continent.</p>
    <p>Maize and the potato travelled east. Wheat, sugar and cattle travelled west, and so did the
       diseases that emptied whole regions of their people within a century of contact.</p>
    <h2>Disease</h2>
    <p>Smallpox and measles were the deadliest. Populations with no previous exposure fell by as
       much as ninety percent in the worst affected regions, which is a figure historians still
       argue about.</p>
    <ul><li>Smallpox</li><li>Measles</li></ul>
  </main>
  <aside><p>Related: the Atlantic slave trade</p></aside>
  <footer><p>Copyright</p></footer>
</body></html>`;

const got = extract(PAGE, { title: 'britannica.com' });
assert.equal(got.title, 'Columbian exchange', 'og:title wins over the tab title');
assert.ok(got.text.includes('transfer of plants'), 'the article did not come through');
assert.ok(got.text.includes('Smallpox and measles'), 'the second section did not come through');
assert.ok(!/tracker|document\.write/.test(got.text), 'a script reached the text');
assert.ok(!/color:red/.test(got.text), 'a stylesheet reached the text');
assert.ok(!/Quizzes/.test(got.text), 'the navigation reached the text');
assert.ok(!/Copyright/.test(got.text), 'the footer reached the text');
assert.ok(!/Atlantic slave trade/.test(got.text), 'the sidebar reached the text');
assert.ok(!/<[a-z]/i.test(got.text), 'a tag survived');

/* Headings are kept, marked, and become the passage they introduce. */
const rows = passages(got.text, { title: got.title });
assert.ok(rows.length >= 2, 'the page should be more than one passage: ' + rows.length);
assert.ok(rows.every(r => r.body && r.body.length <= LINK_LIMITS.passageChars));
assert.ok(rows.every(r => r.heading && r.heading.indexOf('Columbian exchange') === 0), 'every heading names the document: ' + JSON.stringify(rows.map(r => r.heading)));
assert.ok(rows.some(r => /Disease/.test(r.heading)), 'the section heading was lost: ' + JSON.stringify(rows.map(r => r.heading)));
assert.ok(rows.every(r => !//.test(r.body)), 'the heading marker leaked into a passage');
assert.ok(rows.some(r => /ninety percent/.test(r.body)));

/* A page with no article markup still reads. */
const PLAIN = '<html><body><div><p>' + 'A sentence about the topic. '.repeat(60) + '</p></div></body></html>';
const plainRows = passages(extract(PLAIN, { title: 'x' }).text, { title: 'Plain' });
assert.ok(plainRows.length >= 1);
assert.ok(plainRows.every(r => r.body.length <= LINK_LIMITS.passageChars));

/* One enormous paragraph is cut on sentences rather than mid word. */
const HUGE = 'Sentence number one is here. '.repeat(400);
const hugeRows = passages(HUGE, { title: 'Huge' });
assert.ok(hugeRows.length > 3, 'a huge paragraph should become several passages');
assert.ok(hugeRows.length <= LINK_LIMITS.passages, 'the passage cap did not hold');
assert.ok(hugeRows.every(r => /[.!?]\s*$/.test(r.body.trim())), 'a passage stopped mid sentence');

/* Nothing readable gives nothing, rather than an empty passage that looks like a source. */
assert.deepEqual(passages('', { title: 'x' }), []);
assert.deepEqual(passages('   \n\n  ', { title: 'x' }), []);
assert.deepEqual(passages('short', { title: 'x' }), []);
assert.deepEqual(extract('', {}).text, '');

/* The citation label. The site leads, so everything before the first colon names the document and
   the per source cap in index.ts can tell two saved pages apart. */
assert.equal(linkLabel('www.britannica.com', 'Columbian exchange: Disease'), 'britannica.com | Columbian exchange: Disease');
assert.equal(linkLabel('en.wikipedia.org', ''), 'en.wikipedia.org');
assert.ok(linkLabel('x.com', 'y'.repeat(400)).length <= 200);

/* The file keeps the house rules. */
{
  const src = fs.readFileSync(new URL('./link_fetch.mjs', import.meta.url), 'utf8');
  assert.ok(!DASH.test(src), 'dash in link_fetch.mjs');
  assert.ok(!/\bfetch\s*\(/.test(src), 'link_fetch.mjs must not touch the network itself');
  assert.ok(!/Deno\.|process\.env/.test(src), 'it must load under both runtimes');
}

console.log('link reader ok: ' + rows.length + ' passages from the sample page, every refusal checked');
