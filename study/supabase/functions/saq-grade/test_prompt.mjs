// Local check of the grader prompt module. No API call. Run: node test_prompt.mjs
import assert from 'node:assert/strict';
import { GRADE_SCHEMA_JSON, systemPrompt, userContent, modelParams, CANDIDATE_MODELS, PRICES, MAX_TOKENS, THINK_BUDGET, THINK_BUDGET_MODELS, GRADE3_SCHEMA_JSON, systemPrompt3, userContent3, MAX_TOKENS_3 } from './grader_prompt.mjs';
const schema = GRADE_SCHEMA_JSON;
assert.equal(schema.type, 'object'); assert.deepEqual(schema.required, ['verdicts', 'parts', 'coach']);
/* verdicts is written first, so a streamed grade can show the scores before the feedback. */
assert.deepEqual(Object.keys(schema.properties), ['verdicts', 'parts', 'coach']);
assert.deepEqual(schema.properties.coach.required, ['pattern', 'next']); assert.equal(schema.properties.coach.additionalProperties, false);
assert.equal(schema.properties.verdicts.type, 'array'); assert.equal(schema.properties.verdicts.minItems, undefined);
assert.deepEqual(schema.properties.verdicts.items.required, ['earned', 'teacher_earned']);
assert.deepEqual(Object.keys(schema.properties.verdicts.items.properties), ['earned', 'teacher_earned']);
for (const k of ['earned', 'teacher_earned']) assert.equal(schema.properties.verdicts.items.properties[k].type, 'boolean');
assert.equal(schema.properties.verdicts.items.additionalProperties, false);
/* The API rejects minItems above 1, so the schema carries no item count and the prompt asks for three. */
assert.equal(schema.properties.parts.minItems, undefined);
assert.ok(systemPrompt().endsWith('Return only the JSON object the schema describes. Write verdicts first: exactly three, for parts a, b and c, each with earned and teacher_earned. Then parts: exactly three, in the order a, b, c, with the same two verdicts repeated and the full feedback. Then coach.'));
assert.deepEqual(schema.properties.parts.items.required, ['earned', 'teacher_earned', 'why', 'tea', 'tea_notes', 'accuracy', 'fix', 'rewrite', 'teacher']);
assert.ok(/teacher/.test(systemPrompt()) && /College Board standard/.test(systemPrompt()));
const sys = systemPrompt(); assert.ok(sys.length > 200); assert.ok(/one point/i.test(sys));
const u = userContent({ lead: 'L', parts: ['pa', 'pb', 'pc'], rubric: ['ra', 'rb', 'rc'], models: ['ma', 'mb', 'mc'], stimText: 'S', answers: ['x', 'y', 'z'] });
for (const label of ['PROMPT', 'PART A', 'PART B', 'PART C', 'STIMULUS', 'STUDENT ANSWER A', 'STUDENT ANSWER B', 'STUDENT ANSWER C']) assert.ok(u.includes(label), 'missing block ' + label);
assert.equal(CANDIDATE_MODELS.length, 5); for (const m of CANDIDATE_MODELS) assert.ok(PRICES[m] && PRICES[m].in > 0 && PRICES[m].out > 0, m);
assert.ok(modelParams('claude-sonnet-5', 'low').thinking); assert.equal(Object.keys(modelParams('claude-haiku-4-5', 'low')).length, 0);
assert.ok(MAX_TOKENS >= 512);
/* 2026-09-22: grades stopped at exactly 2400 output tokens. Thinking is billed inside max_tokens,
   so a model that takes a budget gets a hard one, and the cap leaves the JSON room after it. */
assert.deepEqual(modelParams('claude-sonnet-4-6', 'low').thinking, { type: 'enabled', budget_tokens: THINK_BUDGET });
assert.ok(THINK_BUDGET >= 1024 && MAX_TOKENS - THINK_BUDGET >= 2400, 'the JSON needs room after the thinking');
assert.equal(modelParams('claude-sonnet-5', 'low').thinking.type, 'adaptive', 'Sonnet 5 refuses a budget');
assert.ok(THINK_BUDGET_MODELS.indexOf('claude-sonnet-5') < 0);
/* The voice: coach, not cheerleader, and the feedback lines are bounded. */
assert.ok(/no "great job"/.test(sys) && /coach\.pattern/.test(sys) && /coach\.next/.test(sys));
for (const s of [sys, u, JSON.stringify(schema)]) assert.ok(!/[\u2014\u2013]/.test(s), 'dash in prompt');
/* Version 2, the teacher's 0 to 3 scale (2026-09-25). */
const s3 = GRADE3_SCHEMA_JSON, sys3 = systemPrompt3();
assert.deepEqual(Object.keys(s3.properties), ['scores', 'parts', 'coach'], 'scores are written first');
assert.deepEqual(s3.properties.scores.items.required, ['pts']);
assert.deepEqual(s3.properties.parts.items.required, ['pts', 'got', 'gap', 'fix', 'fact', 'rewrite', 'tea']);
assert.deepEqual(s3.properties.parts.items.properties.pts.enum, [0, 1, 2, 3]);
assert.equal(s3.properties.parts.minItems, undefined); assert.equal(s3.properties.scores.minItems, undefined);
assert.ok(/out of 3/.test(sys3) && /automatic zero/.test(sys3), 'her rubric');
assert.ok(/"depth"/.test(sys3) && /a little more explanation/.test(sys3), 'her two notes are the anchors');
assert.ok(/not the only acceptable answer/.test(sys3), 'the model is one way, not the only way');
assert.ok(/never a fault/.test(sys3), 'explaining on a describe part never costs');
assert.ok(!/College Board standard/.test(sys3), 'one standard only');
assert.ok(sys3.endsWith('then coach.'));
const u3 = userContent3({ lead: 'L', parts: ['pa', 'pb', 'pc'], rubric: ['ra', 'rb', 'rc'], models: ['ma', 'mb', 'mc'], stimText: 'S', answers: ['x', 'y', 'z'] });
for (const label of ['PROMPT', 'PART A', 'WHAT A 3 NEEDS', 'ONE ANSWER THAT EARNS 3', 'STIMULUS', 'STUDENT ANSWER C']) assert.ok(u3.includes(label), 'missing block ' + label);
assert.ok(MAX_TOKENS_3 - THINK_BUDGET >= 1800, 'the shorter JSON still has room after the thinking');
for (const s of [sys3, u3, JSON.stringify(s3)]) assert.ok(!/[\u2014\u2013]/.test(s), 'dash in prompt v2');
console.log('grader prompt module ok');
