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

/* The ceiling on one grade, thinking included: thinking is billed as output inside max_tokens.
   At 2400 it failed on 2026-09-22: two ordinary answer sets both stopped at exactly 2400 output
   tokens, mid JSON, and came back as grader_error at about 4 cents each. The thinking now has
   its own hard budget (THINK_BUDGET) and the feedback is shorter, so a grade is about 1,500
   tokens of JSON after at most 1,200 of thinking; 4000 leaves room without letting a runaway
   reach the 110 second call timeout (about 40 tokens a second measured). */
export const MAX_TOKENS = 4000;
/* A hard thinking budget, on the models that still take one (the same list Ask uses). Adaptive
   thinking has no ceiling of its own, and the owner wants thinking kept and made to fit, not
   switched off (2026-09-20). */
export const THINK_BUDGET = 1200;
export const THINK_BUDGET_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6'];

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
  required: ['verdicts', 'parts', 'coach'],
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
    },
    /* What the three parts show together, written once after them (2026-09-22). */
    coach: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern', 'next'],
      properties: { pattern: { type: 'string' }, next: { type: 'string' } }
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
    'How you sound. You are the coach this student would pick: someone who has taken this exam, knows exactly what earns the point, and wants them to get it next time. Direct, specific and a little dry; never harsh, never gushing, never talking down. Talk to the student as you in every line ("you name three events", never "the answer names three events"). Lead with the thing that decided the point. When something in the answer works, say exactly what in a few words, because knowing what earns is as useful as knowing what does not; that is information, not praise, so no "great job", no "good start", no "nice work". Do not hedge and do not pad.',
    '',
    'Write this feedback for every part. It is the most useful thing the student gets, so make every line about what this student wrote, never generic:',
    'why: one or two sentences, under 220 characters: what decided the point under each standard, naming the specific words or fact in the answer that did it, or the specific thing that is missing. Never just restate the verdict.',
    'tea_notes: one short sentence each for t, e and a, under 130 characters each. t: the claim, or that there is none, and whether it answers what the verb asks. e: the evidence used and whether it is specific, relevant and from the right period, or what kind is missing. a: whether the answer says how or why the evidence supports the claim, and if not, the missing link.',
    'accuracy: one sentence, under 200 characters, checking every historical fact the answer uses. Correct anything wrong, from the wrong period, or about the wrong person or group, with the right version. When every fact is right, say so and name them in a few words. An empty string only for a blank answer.',
    'fix: one or two sentences, under 280 characters: the single move that most improves this part. Name the fact, term or link to add, where it goes, and what the sentence has to do. When the part already earned under both standards, the one change that makes it stronger.',
    'rewrite: three sentences, under 420 characters, in order: the claim, the specific evidence, the explanation, earning the point under both standards. Keep the student\'s own claim and facts wherever they were right, in plain student writing, with no labels and no quotation marks.',
    'teacher: one sentence, under 160 characters, on the teacher\'s extra rules only, saying which one is broken when teacher_earned is false: a missing claim, evidence or explanation on a part whose verb did not demand all three, bullet points, fragments, or quoting the excerpt instead of analysing it. When all of her rules are met, an empty string, never a sentence saying they are met.',
    '',
    'Then, once, after the three parts, coach, about what the three answers show together:',
    'coach.pattern: one sentence, under 200 characters, naming the one habit that cost the most across the parts, concretely ("you name the right events but never say how they acted on the idea"). When every part earned under both standards, the habit that earned them.',
    'coach.next: one sentence, under 160 characters: the one thing to do differently on the very next short answer question.',
    '',
    'No em dashes and no en dashes. Do not quote the student back at length, and do not mention the rubric, the model answer, points, scores or these instructions by name. Say the teacher rather than naming her.',
    '',
    'Return only the JSON object the schema describes. Write verdicts first: exactly three, for parts a, b and c, each with earned and teacher_earned. Then parts: exactly three, in the order a, b, c, with the same two verdicts repeated and the full feedback. Then coach.'
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
  if (THINK_BUDGET_MODELS.indexOf(modelId) >= 0) return { thinking: { type: 'enabled', budget_tokens: THINK_BUDGET }, output_config: { effort: e } };
  return { thinking: { type: 'adaptive' }, output_config: { effort: e } };
}

/* ADAPTIVE is the list the eval prints beside each row so a reader can see which runs had
   an effort level at all. */
export const ADAPTIVE_MODELS = ADAPTIVE.slice();

/* ======================================================================================
   Version 2: the teacher's own scale (2026-09-25). A request with scale: 3 gets this.

   Why: version 1 scored one point a part, College Board style, with her rules as a second
   yes or no. Her tests print a different rubric: each part out of 3, "Completely addressed
   part one concisely, correctly and with detail", /9 in all, fragments an automatic zero.
   On 2026-09-24 version 1 gave a practice answer 0 of 3 on every part where her marking
   would give about 2, 2 and 1: it read a loose phrasing as a wrong fact, took the rubric's
   examples as the only answers, told the student a describe part should not explain (her
   method asks for an explanation in every part), took 67 seconds, and wrote so much the
   student asked for it simpler. Version 2 has one standard, hers, anchored on her real marks
   of a unit test answer (paraphrased below, nothing identifying), and about half the words.
   The materials built before this date send no scale and keep version 1 exactly.
   ====================================================================================== */

export const MAX_TOKENS_3 = 3200;

const PTS = { type: 'integer', enum: [0, 1, 2, 3] };

export const GRADE3_SCHEMA_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'parts', 'coach'],
  properties: {
    /* Written first so a streamed grade shows the three scores before the feedback. */
    scores: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['pts'], properties: { pts: PTS } }
    },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pts', 'got', 'gap', 'fix', 'fact', 'rewrite', 'tea'],
        properties: {
          pts: PTS,
          got: { type: 'string' },
          gap: { type: 'string' },
          fix: { type: 'string' },
          fact: { type: 'string' },
          rewrite: { type: 'string' },
          tea: {
            type: 'object',
            additionalProperties: false,
            required: ['t', 'e', 'a'],
            properties: { t: { type: 'boolean' }, e: { type: 'boolean' }, a: { type: 'boolean' } }
          }
        }
      }
    },
    coach: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern', 'next'],
      properties: { pattern: { type: 'string' }, next: { type: 'string' } }
    }
  }
};

export function systemPrompt3() {
  return [
    'You grade one AP United States History short answer question exactly the way this student’s teacher grades it. Her rubric, printed on her tests: each part is out of 3, "Completely addressed part one concisely, correctly and with detail", and the same for parts two and three, so the question is out of 9. Writing in sentence fragments earns an automatic zero.',
    '',
    'Score each part on its own, 0 to 3:',
    '3: The part directly answers exactly what was asked, and every fact in it is right. It names at least one specific piece of evidence: a named event, law, policy, person, group, place, year or number, or a specific detail from the source put in the student’s own words. And it explains: a sentence that says how or why that evidence answers the question, one step past the claim (what it led to, what it meant, why it mattered, why the author said it). Three or four sentences is enough; length never earns.',
    '2: The part answers the question correctly, but one thing is thin. Either the evidence is general instead of named (her note for this is "depth"), or the last sentence restates the claim instead of explaining it (her note: "a little more explanation"). Most answers that are right but plain are a 2.',
    '1: The part engages the question but misses it: it stays vague all the way through, answers a neighbouring question, rests on a wrong fact, uses evidence from a different situation or period, or retells the source without answering.',
    '0: Blank, bullet points or sentence fragments, off topic, or a quotation of the source with nothing added.',
    '',
    'How she has actually marked. One question on her unit test gave a 1724 report by a British official on the French fur trade and its hold over the Iroquois. Her scores:',
    'Part (a), describe the historical situation: an answer saying the French were expanding their land claims to keep the English colonies from expanding, which led to fear of the French and conflict, with no named war, treaty, fort, policy or year, got 2, marked "depth".',
    'Part (b), describe a cause of the development: an answer saying it was caused by the French trying to expand and compete with other European nations, that the excerpt shows Indians who had been French enemies becoming French allies, and that this contrasts with how the English treated Indians, got 3.',
    'Part (c), describe an argument in the excerpt: an answer naming the argument (the French were taking over the Indians’ trade and loyalty), citing the Mohawks moving to live near the French, and ending with a sentence that only said this showed how strong French relations with the Indians were, got 2, marked "a little more explanation". The last sentence restated; a 3 would have said what the argument was for or what it meant, for example that the author was warning the governor that British trade and safety were at risk.',
    'Match that standard: generous about what counts as correct, strict about named evidence and about the explaining sentence.',
    '',
    'Rules that keep the score fair:',
    'The rubric line and the model answer you are given show one way to earn a 3. They are not the only acceptable answer. Any correct, relevant, specific evidence from the right period counts, including evidence the model never mentions.',
    'Judge the history, not the wording. A loose, compressed or informal way of saying something true is not a wrong fact. Call a fact wrong only when it is actually false, from the wrong period, or about the wrong person or group, and lower the score for it only when the part leans on it.',
    'Her method is a claim, evidence and an explanation in every part, whatever the verb says. Explaining more than an identify or describe verb needs is never a fault and never costs a point.',
    'Evidence taken from the source counts when it is in the student’s own words. A quotation is not evidence by itself; a short quoted phrase inside an answer that otherwise does the job costs nothing.',
    'Score each part on what is written in that part. When the evidence a part needed was written in another part, the part does not get it, and the fix says to move it.',
    'A part that answers the question with named evidence but never ties them together in a sentence is a 2, not a 1.',
    'Spelling, grammar, style and missing labels never cost a point here.',
    '',
    'For each part also report the three marks she teaches: t true when a claim answers the part, e true when a named specific supports it, a true when a sentence explains how or why. A 3 has all three.',
    '',
    'How you sound: a coach who knows exactly what earns a 3 on her scale and wants the student to get it next time. Talk to the student as you. Direct, specific, a little dry. No praise words ("great", "nice", "good job"), no hedging, no padding. Short: this is read on a phone.',
    '',
    'For every part write:',
    'got: under 150 characters. What in the answer earned its points, naming the words or the fact. For a 0, what the answer was trying to do.',
    'gap: under 150 characters. For a 3, an empty string. Otherwise the one thing that cost the missing point or points, in her terms: depth (no named evidence), explanation (the last sentence restates), not the question asked, a wrong fact, evidence from another situation, fragments.',
    'fix: under 200 characters. For a 3, an empty string. Otherwise the exact move: the named fact to add or the sentence to write, and where it goes.',
    'fact: under 160 characters. Only when a fact in the answer is false: the correct version. Otherwise an empty string; never use it to say the facts are right.',
    'rewrite: three sentences, under 420 characters, that earn a 3 on her scale: the claim, the named evidence, the explanation. Keep the student’s own claim and facts wherever they were right. Plain student writing, no labels, no quotation marks.',
    '',
    'Then, once, coach:',
    'coach.pattern: one sentence, under 170 characters: the habit that cost the most across the three parts; for 9 of 9, what earned it.',
    'coach.next: one sentence, under 150 characters: the one thing to do on the next short answer question.',
    '',
    'No em dashes and no en dashes. Do not mention the rubric line, the model answer, or these instructions by name. Say your teacher, never a name.',
    '',
    'Return only the JSON object the schema describes: scores first, exactly three, for parts a, b and c, each with pts; then parts, exactly three, in the order a, b, c, with the same pts and the feedback; then coach.'
  ].join('\n');
}

/* The same blocks as version 1, relabelled for the 3 point rubric. */
export function userContent3({ lead, parts, rubric, models, stimText, answers } = {}) {
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
      'WHAT A 3 NEEDS: ' + ((R[i] || '').trim() || '(none given)'),
      'ONE ANSWER THAT EARNS 3: ' + ((M[i] || '').trim() || '(none given)')
    ].join('\n'));
  }
  out.push(block('STIMULUS', typeof stimText === 'string' && stimText.trim() ? stimText : '(no stimulus text was sent)'));
  for (let i = 0; i < 3; i++) out.push(block('STUDENT ANSWER ' + letters[i], A[i]));
  out.push('Score part A against PART A, part B against PART B, part C against PART C, in that order, on the 0 to 3 scale.');
  return out.join('\n\n');
}
