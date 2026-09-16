// Local check of the grader prompt module. No API call. Run: node test_prompt.mjs
import assert from 'node:assert/strict';
import { GRADE_SCHEMA_JSON, systemPrompt, userContent, modelParams, CANDIDATE_MODELS, PRICES, MAX_TOKENS } from './grader_prompt.mjs';
const schema = GRADE_SCHEMA_JSON;
assert.equal(schema.type, 'object'); assert.deepEqual(schema.required, ['parts']);
/* The API rejects minItems above 1, so the schema carries no item count and the prompt asks for three. */
assert.equal(schema.properties.parts.minItems, undefined); assert.ok(/exactly three parts/.test(systemPrompt()));
assert.deepEqual(schema.properties.parts.items.required, ['earned', 'teacher_earned', 'why', 'fix', 'example', 'teacher', 'tea']);
assert.ok(/teacher/.test(systemPrompt()) && /College Board standard/.test(systemPrompt()));
const sys = systemPrompt(); assert.ok(sys.length > 200); assert.ok(/one point/i.test(sys));
const u = userContent({ lead: 'L', parts: ['pa', 'pb', 'pc'], rubric: ['ra', 'rb', 'rc'], models: ['ma', 'mb', 'mc'], stimText: 'S', answers: ['x', 'y', 'z'] });
for (const label of ['PROMPT', 'PART A', 'PART B', 'PART C', 'STIMULUS', 'STUDENT ANSWER A', 'STUDENT ANSWER B', 'STUDENT ANSWER C']) assert.ok(u.includes(label), 'missing block ' + label);
assert.equal(CANDIDATE_MODELS.length, 5); for (const m of CANDIDATE_MODELS) assert.ok(PRICES[m] && PRICES[m].in > 0 && PRICES[m].out > 0, m);
assert.ok(modelParams('claude-sonnet-5', 'low').thinking); assert.equal(Object.keys(modelParams('claude-haiku-4-5', 'low')).length, 0);
assert.ok(MAX_TOKENS >= 512);
for (const s of [sys, u]) assert.ok(!/[\u2014\u2013]/.test(s), 'dash in prompt');
console.log('grader prompt module ok');
