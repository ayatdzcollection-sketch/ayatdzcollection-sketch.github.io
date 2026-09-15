# saq-grade: the AI grader for the short answer question

One Supabase Edge Function. It takes a student's three typed answers to one SAQ from
`apush/period1-2-test`, asks Postgres for permission and a budget (`ai_begin`), makes exactly
one Claude call with the prompt in `grader_prompt.mjs`, closes the ledger row (`ai_end`), and
returns a grade per part. It runs only when the owner has turned AI grading on in the hub's
owner panel; until then every call answers `{ok:false, error:'off'}` and the material marks
the answer the manual way.

## Request

`POST /functions/v1/saq-grade` with the public key in `apikey` and `Authorization: Bearer`,
an `Origin` header of `https://ayatdzcollection-sketch.github.io` or `http://localhost:8000`
(anything else, or no header, is refused with 403), and a JSON body:

```
{ material: 'apush/period1-2-test', install: '<32 hex>', saqId, lead, parts: [a, b, c],
  rubric: [a, b, c], models: [a, b, c], stimText?, answers: [a, b, c], adminToken? }
```

Answers are at most 1199 characters each and their total must be under the owner's
`max_chars` (checked before any ledger row is opened). `adminToken` is the owner's session
token and is only needed in owner mode.

## Response

`{ ok: true, parts: [{ earned, why, fix, tea: { t, e, a } }, x3], model, cost_cents }` or
`{ ok: false, error }` where `error` is one of `off`, `owner_only`, `daily_cap`, `monthly_cap`,
`device_cap`, `slow_down`, `too_long` (with `max_chars`), `refused`, `grader_error`,
`bad_request`, `forbidden`. The material shows one plain sentence per code and falls back to
the manual buttons.

## Deploy

Either path; the repo file is the source of truth (the dashboard editor keeps no history).

1. Dashboard: Edge Functions, "Deploy a new function", "Via Editor", name `saq-grade`, paste
   `index.ts`; add `grader_prompt.mjs` as a second file if the editor allows files, otherwise
   inline its contents at the top of `index.ts` in place of the import line.
2. CLI: `npx supabase@latest login`, then
   `npx supabase@latest functions deploy saq-grade --project-ref gyfqhkhgosjpyvatffbi`
   from the `study/` folder (the CLI expects `supabase/functions/<name>/index.ts`).

Then set the secret `ANTHROPIC_API_KEY` under Edge Functions, Secrets. Leave "Verify JWT"
on: the material sends the public key. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform. Run `0010_ai_grading.sql` first or every call answers `off`.

## Smoke test

```bash
curl -s -X POST "https://gyfqhkhgosjpyvatffbi.supabase.co/functions/v1/saq-grade" \
  -H "apikey: sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb" \
  -H "Authorization: Bearer sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb" \
  -H "Origin: http://localhost:8000" -H "Content-Type: application/json" \
  -d '{"material":"apush/period1-2-test","install":"0123456789abcdef0123456789abcdef","saqId":"saq-bacon","lead":"x","parts":["a","b","c"],"rubric":["a","b","c"],"models":["a","b","c"],"answers":["one","two","three"]}'
```

Expected while the feature is off: `{"ok":false,"error":"off"}`. Without the Origin header:
403. With the feature on in open mode and a real answer: a grade in a few seconds and one row
in `study_ai_calls` with tokens and cost and no text.

## Local check

`node test_prompt.mjs` (no API call) asserts the prompt module's schema and blocks.
`deno check index.ts` needs the network for the npm imports.
