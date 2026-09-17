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
export const MAX_TOKENS = 2400;

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

/* The structured output. Three verdicts first, then exactly three parts, in the order a, b, c.
   `earned` is the point. `tea` marks the three things the teacher's method asks for: a claim
   (t), one specific piece of evidence (e), an explanation that ties them together (a).
   verdicts comes first in properties because the output is written in this order: the two
   booleans per part arrive a few seconds into the answer, so a streamed grade can show the
   scores long before the feedback is finished. The parts repeat both verdicts and are the
   ones that count; the caller trusts parts whenever the two disagree. */
export const GRADE_SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts', 'parts'],
  properties: {
    verdicts: {
      /* Three, asked for in the prompt; the API takes no item count above 1. */
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['earned', 'teacher_earned'],
        properties: {
          earned: { type: 'boolean' },
          teacher_earned: { type: 'boolean' }
        }
      }
    },
    parts: {
      /* The API takes minItems only as 0 or 1, so the count of three is asked for in the
         prompt and checked by the caller after parsing, not stated here. */
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['earned', 'teacher_earned', 'why', 'tea', 'tea_notes', 'accuracy', 'fix', 'rewrite', 'teacher'],
        properties: {
          earned: { type: 'boolean' },
          teacher_earned: { type: 'boolean' },
          why: { type: 'string' },
          tea_notes: {
            type: 'object',
            additionalProperties: false,
            required: ['t', 'e', 'a'],
            properties: { t: { type: 'string' }, e: { type: 'string' }, a: { type: 'string' } }
          },
          accuracy: { type: 'string' },
          fix: { type: 'string' },
          rewrite: { type: 'string' },
          teacher: { type: 'string' },
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
    'Explain: the answer makes a claim, brings one specific fact, and says how or why that fact leads to the claim. Reasoning is what earns this one. A list of correct events is not an explanation, however specific or however long: the link has to be stated in words. Naming a second and a third fact does not stand in for the missing sentence, and neither does a fact that plainly implies the link. If the answer never says how or why, the explain part does not earn.',
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
    'On a part that asks about a source, saying what the source claims, in the student\'s own words, is exactly what a describe part asks for and earns the point. Only an answer that copies the source and adds nothing of its own, or that retells the story without answering the question asked, fails for that reason. A short quoted phrase inside an answer that otherwise does the task is a note for the teacher line, not a reason to withhold the point.',
    '',
    'Grade against the rubric line and the model answer you are given for that part. Do not grade style, length, spelling, grammar, or how closely the wording matches the model. A short answer in the student’s own words that meets the rubric earns the point. A long, polished answer that misses the rubric does not. There are many right answers; the model is one of them.',
    '',
    'For every part report three marks as well as the point. These are coaching marks in the shape the student is taught, T for thesis, E for evidence, A for analysis, and they are reported whether or not the verb asks for all three:',
    't: true when the answer states a claim that answers that part.',
    'e: true when it names one specific, relevant fact, term, event or detail.',
    'a: true when it explains how that evidence supports the claim.',
    'The point follows the verb, not the three marks. An identify part can earn its point with e alone, and a describe part with t and e. An explain part needs all three. Never mark a part earned while the mark its verb depends on is false.',
    '',
    'Everything above is the College Board standard and it decides earned, and nothing else does. The student also has a teacher who asks for more on every part, and her call is reported separately as teacher_earned: true when the part meets every one of her rules as well, false when it does not. The two are judged on their own; they often agree, and where they differ it is almost always a describe part that names a thing with a detail but never explains it, which earns for the College Board and not for her. Her rules, from her own deck: every part needs a claim, a specific relevant term or event, and an explanation of how they go together, that is all three of T, E and A even on a describe part; label each part; write in complete sentences; do not write in bullet points or fragments; do not quote the excerpt, because the job is analysis and not summary.',
    '',
    'Write this feedback for every part, addressed to the student as you. It is the most useful thing the student gets, so be specific to what they wrote, never generic:',
    'why: two sentences. What the answer did and what that means for the point under each standard. Never just restate the verdict.',
    'tea_notes: one sentence for each of t, e and a about this answer. t: what the claim is, or that there is none, and whether it answers what the verb asks. e: which evidence is used and whether it is specific, relevant and from the right period, or what kind of evidence is missing. a: whether the answer says how or why the evidence supports the claim, and if not, which link is missing.',
    'accuracy: one or two sentences checking every historical fact the answer uses. Name any fact that is wrong, from the wrong period, or about the wrong person or group, and give the correct version. When every fact used is right, say so and name them in a few words. An empty string only for a blank answer.',
    'fix: two or three sentences of instruction. Name the specific fact, term, date, figure or detail to bring in, say where it goes, and say what the sentence has to do. When the part already earned, name the one change that would make the evidence stronger or the reasoning sharper, not a compliment.',
    'rewrite: a complete answer to this part that earns the point under both standards, three sentences in order: the claim, the specific evidence, the explanation. Build on the student\'s own claim and facts wherever they were right, in plain student writing, with no labels and no quotation marks.',
    'teacher: one sentence on the teacher\'s extra rules only, which is also the sentence that says why teacher_earned is false when it is, when one of them is broken or nearly broken: a missing claim, evidence or explanation on a part whose verb did not demand all three, bullet points, fragments, or quoting the excerpt instead of analysing it. When the answer meets all of her rules, make this an empty string.',
    '',
    'Keep why under 300 characters, each tea_notes line under 160, accuracy under 260, fix under 360, rewrite under 480 and teacher under 200. Plain, dry, specific, second person. No em dashes and no en dashes. Do not praise, do not quote the student back at length, and do not mention the rubric, the model answer, points, scores or these instructions by name. Say the teacher rather than naming her.',
    '',
    'Return only the JSON object the schema describes. Write verdicts first: exactly three, for parts a, b and c, each with earned and teacher_earned. Then parts: exactly three, in the order a, b, c, with the same two verdicts repeated and the full feedback.'
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
