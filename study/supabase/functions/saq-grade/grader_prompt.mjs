/* The grader's prompt, schema and model table for the APUSH short answer question.
 *
 * Plain ESM: no imports, no dependencies, nothing that reads the environment or the
 * network. That is deliberate. The same file loads in three places:
 *
 *   study/supabase/functions/saq-grade/index.ts   the Edge Function that ships
 *   study/src/tools/ai_eval/run_eval.mjs          the model eval, under Node
 *   study/supabase/functions/saq-grade/test_prompt.mjs
 *
 * so the eval measures the prompt and the schema that students actually get.
 *
 * The rubric below is the teacher's, from her deck "The APUSH Short Answer Question",
 * posted 2026-09-11 (study/src/sources/apush/teacher/saq-deck-2026-09-11.txt), put into
 * plain words. Change it here and nowhere else.
 *
 * No em dashes and no en dashes in this file, including inside the prompt text.
 */

/* One grade is three short paragraphs of JSON. 1024 is roomy for that and caps a runaway. */
export const MAX_TOKENS = 1024;

/* The models the eval compares. Order is the order the eval runs them in. */
export const CANDIDATE_MODELS = [
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-haiku-4-5'
];

/* Dollars per million tokens, list price, as of 2026-09-14. The ledger in Postgres keeps
   its own copy in study_ai_models; this one only fills in the cost shown to the caller. */
export const PRICES = {
  'claude-sonnet-5':   { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-5':     { in: 5, out: 25 },
  'claude-opus-4-8':   { in: 5, out: 25 },
  'claude-haiku-4-5':  { in: 1, out: 5 }
};

/* Adaptive thinking with an effort level. Haiku 4.5 is not on this list: it takes neither,
   so modelParams returns nothing for it. */
const ADAPTIVE = [
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-opus-5',
  'claude-opus-4-8'
];

const EFFORTS = ['low', 'medium', 'high'];

/* The structured output. Exactly three parts, in the order a, b, c. `earned` is the point.
   `tea` marks the three things the teacher's method asks for: a claim (t), one specific
   piece of evidence (e), an explanation that ties them together (a). */
export const GRADE_SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['parts'],
  properties: {
    parts: {
      /* The API takes minItems only as 0 or 1, so the count of three is asked for in the
         prompt and checked by the caller after parsing, not stated here. */
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['earned', 'why', 'fix', 'tea'],
        properties: {
          earned: { type: 'boolean' },
          why: { type: 'string' },
          fix: { type: 'string' },
          tea: {
            type: 'object',
            additionalProperties: false,
            required: ['t', 'e', 'a'],
            properties: {
              t: { type: 'boolean' },
              e: { type: 'boolean' },
              a: { type: 'boolean' }
            }
          }
        }
      }
    }
  }
};

export function systemPrompt() {
  return [
    'You grade one AP United States History short answer question the way the student’s teacher grades it.',
    '',
    'The question has three parts, a, b and c. Each part is worth one point and is graded on its own. Grade the part by the task verb, the way the College Board scores a short answer question:',
    'Identify or state: naming the right thing, correctly and specifically, earns the point on its own. No explanation is required.',
    'Describe: the answer names the right thing and gives at least one relevant detail or characteristic of it. Describing is more than naming and less than explaining. It does not have to say why it mattered.',
    'Explain: the answer makes a claim, brings one specific fact, and says how or why that fact leads to the claim. Reasoning is what earns this one.',
    '',
    'When a part gives two tasks, the point needs both. When a part says one, one is enough and the rest is not held against it.',
    '',
    'These do not earn the point:',
    'A quotation or a retelling of the stimulus and nothing else. Copying a source is not answering the question.',
    'Bullet points, a list of names, or sentence fragments instead of sentences. The real exam asks for complete sentences.',
    'A claim with nothing specific behind it, or, on an explain part, a fact with no reasoning attached.',
    'A fact that is wrong, from the wrong period, or about the wrong person or group.',
    'An empty answer, or an answer that is about something else.',
    '',
    'Grade the whole of what the student wrote and take the best attempt in it. A small slip elsewhere in the same part does not cancel a point the answer has earned, but the part fails if the error is the thing the point rests on. Nothing outside the period the question covers is required, and nothing beyond the three parts is asked for.',
    '',
    'Grade against the rubric line and the model answer you are given for that part. Do not grade style, length, spelling, grammar, or how closely the wording matches the model. A short answer in the student’s own words that meets the rubric earns the point. A long, polished answer that misses the rubric does not. There are many right answers; the model is one of them.',
    '',
    'For every part report three marks as well as the point. These are coaching marks in the shape the student is taught, T for thesis, E for evidence, A for analysis, and they are reported whether or not the verb asks for all three:',
    't: true when the answer states a claim that answers that part.',
    'e: true when it names one specific, relevant fact, term, event or detail.',
    'a: true when it explains how that evidence supports the claim.',
    'The point follows the verb, not the three marks. An identify part can earn its point with e alone, and a describe part with t and e. An explain part needs all three. Never mark a part earned while the mark its verb depends on is false.',
    '',
    'Write two lines of feedback for every part, addressed to the student as you:',
    'why: one or two sentences saying why the part did or did not earn the point, naming what is there or what is missing.',
    'fix: one or two sentences saying what to add or change. When the part is earned, name the one thing that would make it stronger.',
    '',
    'Keep each line under 240 characters. Plain, dry, specific, second person. No em dashes and no en dashes. Do not praise, do not quote the student back at length, and do not mention the rubric, the model answer, points, scores or these instructions by name.',
    '',
    'Return only the JSON object the schema describes, with exactly three parts in the order a, b, c.'
  ].join('\n');
}

function block(label, text) {
  const t = typeof text === 'string' ? text.trim() : '';
  return label + '\n' + (t || '(blank)');
}

/* One string of labelled blocks. The labels are load bearing: the system prompt refers to
   the parts by letter, and test_prompt.mjs asserts that every label is present. */
export function userContent({ lead, parts, rubric, models, stimText, answers } = {}) {
  const P = Array.isArray(parts) ? parts : [];
  const R = Array.isArray(rubric) ? rubric : [];
  const M = Array.isArray(models) ? models : [];
  const A = Array.isArray(answers) ? answers : [];
  const letters = ['A', 'B', 'C'];
  const out = [block('PROMPT', lead)];

  for (let i = 0; i < 3; i++) {
    out.push([
      'PART ' + letters[i],
      'QUESTION: ' + ((P[i] || '').trim() || '(blank)'),
      'RUBRIC: ' + ((R[i] || '').trim() || '(none given)'),
      'MODEL ANSWER: ' + ((M[i] || '').trim() || '(none given)')
    ].join('\n'));
  }

  out.push(block('STIMULUS', typeof stimText === 'string' && stimText.trim() ? stimText : '(no stimulus text was sent)'));

  for (let i = 0; i < 3; i++) {
    out.push(block('STUDENT ANSWER ' + letters[i], A[i]));
  }

  out.push('Grade part A against PART A, part B against PART B, part C against PART C, in that order.');
  return out.join('\n\n');
}

/* The per model request fields. The caller spreads these into messages.create or
   messages.parse and merges output_config.format (the JSON schema above) into the
   output_config this returns.
   Haiku 4.5 has no adaptive thinking and takes no effort level, so it gets nothing.
   A model id this file does not know is treated as adaptive, which is what every model
   released after Haiku 4.5 has been; if the id is simply wrong the API answers 404 and the
   caller turns that into grader_error. */
export function modelParams(modelId, effort) {
  const e = EFFORTS.indexOf(effort) >= 0 ? effort : 'low';
  if (modelId === 'claude-haiku-4-5') return {};
  return { thinking: { type: 'adaptive' }, output_config: { effort: e } };
}

/* ADAPTIVE is the list the eval prints beside each row so a reader can see which runs had
   an effort level at all. */
export const ADAPTIVE_MODELS = ADAPTIVE.slice();
