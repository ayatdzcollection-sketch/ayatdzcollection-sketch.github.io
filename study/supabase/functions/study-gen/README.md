# study-gen

Writes a few multiple choice practice questions for one section of a material. The owner's
decision of 2026-09-26 (CLAUDE.md, Paid APIs, item 4). Migration `0052_generated_questions.sql`.

- **Who**: the owner only (feature row `gen`, mode owner, its own daily cap, off by default), for a
  material tagged `ai-gen` in `materials.json`. The page's owner views hold the only button.
- **What it reads**: the material's own reading checks and explanations for the section (sent by
  the page from its own data) and, when the chapter's corpus is loaded, the textbook's passages
  (`CORPUS` in `index.ts`). Nothing else: no web, no other material.
- **What it keeps**: only questions that pass every check in `gen_prompt.mjs` (four distinct
  options, one key, a misconception code on every wrong option, the cited words found in the
  grounding, no dashes, not a copy of the bank, never a Key Term definition). They go to
  `study_gen_items` through `gen_insert`; the reply says how many were kept and why the rest were
  dropped.
- **After**: anyone reads the live and promoted ones (`gen_items`); a flag from two devices, or a
  key most people miss, retires one; the owner promotes, retires or puts back
  (`admin_gen_list`, `admin_gen_set`).

Checks with no call: `node study/supabase/functions/study-gen/test_gen.mjs`.
Type check: `deno check study/supabase/functions/study-gen/index.ts`.
Deploy with the others: `sh study/supabase/functions/saq-grade/deploy.sh` (after migration 0052 is
applied, and only on the owner's go). A first real run is a paid call: only after the owner says go,
under the gen row's cap.
