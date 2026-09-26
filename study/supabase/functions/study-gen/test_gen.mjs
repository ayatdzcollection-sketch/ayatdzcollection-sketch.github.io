/* Checks for study-gen's code checks, with no call: node study/supabase/functions/study-gen/test_gen.mjs
 * No em dashes and no en dashes. */
import assert from 'node:assert/strict';
import { checkItem, checkReply, systemPrompt, userContent, GEN_SCHEMA_JSON } from './gen_prompt.mjs';

const grounding = 'FROM THE MATERIAL (Ch. 6, The Articles of Confederation):\nUnder the Articles of Confederation, Congress could not levy taxes and needed nine of the thirteen states to pass major laws. The Northwest Ordinance of 1787 banned slavery north of the Ohio River.';
const ctx = { grounding, existing: ['Under the Articles of Confederation, which power did Congress lack?'], terms: ['Articles of Confederation', 'Northwest Ordinance of 1787', "Shays's Rebellion"], count: 3, label: 'Ch. 6' };
const good = { q: 'All of the following were true under the Articles EXCEPT', o: ['Congress could not levy taxes', 'Nine states were needed for major laws', 'Congress could tax imports directly', 'Slavery was banned north of the Ohio River'], a: 2, why: 'Congress could not levy taxes.', mis: ['xt', 'xt', '', 'xt'], x: true, quote: 'Congress could not levy taxes and needed nine of the thirteen states', page: 'book page 172' };
let r = checkItem(good, ctx);
assert.ok(r.item, 'a good item is kept: ' + r.drop);
assert.equal(r.item.mis[2], null);
assert.equal(r.item.cite.page, 'book page 172');

const bad = (patch, why) => { const x = checkItem(Object.assign({}, good, patch), ctx); assert.ok(!x.item, why); return x.drop; };
assert.equal(bad({ o: good.o.slice(0, 3) }, 'three options'), 'options');
assert.equal(bad({ o: ['a a a', 'a a a', 'b b b', 'c c c'] }, 'repeat'), 'options repeat');
assert.equal(bad({ o: ['All of the above', 'x y z', 'p q r', 'm n o'] }, 'aota'), 'all of the above');
assert.equal(bad({ mis: ['xt', 'xt', 'xt', 'xt'] }, 'tag on key'), 'tag on the key');
assert.equal(bad({ mis: ['xt', 'xt', '', 'wrong'] }, 'bad code'), 'untagged wrong option');
assert.equal(bad({ quote: 'Congress had the power to tax every state freely' }, 'invented quote'), 'quote not in the grounding');
assert.equal(bad({ why: 'Congress could not tax — at all.' }, 'dash'), 'dash');
assert.equal(bad({ q: 'Under the Articles of Confederation, which power did Congress lack?', x: false }, 'copy'), 'copy of the bank');
assert.equal(bad({ q: 'Which of the following best describes the Northwest Ordinance of 1787?', x: false }, 'definition'), 'a Key Term definition');
assert.equal(bad({ x: true, q: 'Which was true under the Articles?' }, 'x flag'), 'EXCEPT flag without EXCEPT');
assert.ok(checkItem(Object.assign({}, good, { mis: ['mix:articles|ordinance', 'xt', '', 'xt'] }), ctx).item, 'a mix code is allowed');

const reply = checkReply({ items: [good, Object.assign({}, good, { q: good.q + ' (again)' }), Object.assign({}, good, { a: 7 })] }, ctx);
assert.equal(reply.items.length, 1, 'the near copy of the first kept item is dropped');
assert.deepEqual(reply.dropped, ['copy of the bank', 'key']);

for (const s of [systemPrompt(), userContent({ section: 's', count: 2, grounding, existing: [] }), JSON.stringify(GEN_SCHEMA_JSON)]) assert.ok(!/[–—]/.test(s), 'no dash in the prompt');
console.log('study-gen checks: all pass');
