# saq-grade: the AI grader for the short answer question

One Supabase Edge Function. It takes a student's three typed answers to one SAQ from
`apush/period1-2-test`, asks Postgres for permission and a budget (`ai_begin`), makes exactly
one Claude call with the prompt in `grader_prompt.mjs`, closes the ledger row (`ai_end`), and
returns a grade per part, as one JSON reply or, with `stream: true`, as Server Sent Events that
show the three verdicts first. It runs only when the owner has turned AI grading on in the hub's
owner panel; until then every call answers `{ok:false, error:'off'}` and the material marks
the answer the manual way.

## The one command path

With a Supabase access token (account settings, Access Tokens) and the Anthropic key in the
environment, this does both steps at once and writes neither secret to disk:

    export SUPABASE_ACCESS_TOKEN=sbp_...
    export ANTHROPIC_API_KEY=sk-ant-...
    sh study/supabase/functions/saq-grade/deploy.sh


## Request

`POST /functions/v1/saq-grade` with the public key in `apikey` and `Authorization: Bearer`,
an `Origin` header of `https://ayatdzcollection-sketch.github.io` or `http://localhost:8000`
(anything else, or no header, is refused with 403), and a JSON body:

```
{ material: 'apush/period1-2-test', install: '<32 hex>', saqId, lead, parts: [a, b, c],
  rubric: [a, b, c], models: [a, b, c], stimText?, answers: [a, b, c], adminToken?, stream? }
```

Answers are at most 1199 characters each and their total must be under the owner's
`max_chars` (checked before any ledger row is opened). `adminToken` is the owner's session
token and is only needed in owner mode. `stream`, when present, must be a boolean.

## Response

Without `stream: true` (what an older cached copy of the material sends):
`{ ok: true, parts: [part, part, part], model, cost_cents }` where each part is
`{ earned, teacher_earned, why, tea: { t, e, a }, tea_notes: { t, e, a }, accuracy, fix, rewrite, teacher }`,
or `{ ok: false, error }` where `error` is one of `off`, `owner_only`, `daily_cap`, `monthly_cap`,
`device_cap`, `slow_down`, `too_long` (with `max_chars`), `refused`, `grader_error`,
`bad_request`, `forbidden`. The material shows one plain sentence per code and falls back to
the manual buttons.

The model writes `verdicts` (three `{ earned, teacher_earned }`) before `parts`. The parts decide
the grade: where the two disagree the parts win. A grade with fewer than three parts is
`grader_error`; one with more than three keeps the first three.

### Streamed, with `stream: true`

Every refusal before spend (`bad_request`, `forbidden`, `off`, the caps, `too_long`) is still the
JSON reply above: the stream only opens once `ai_begin` has let the call through. Then `200`,
`Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, and one
`data: <json>` line per event, each followed by a blank line:

```
data: {"type":"verdicts","verdicts":[{"earned":true,"teacher_earned":false},x3]}
data: {"type":"part","index":0,"part":{...}}         then index 1 and 2
data: {"type":"done","parts":[part,part,part],"model":"claude-sonnet-5","cost_cents":1.234}
```

or, instead of `done`, `data: {"type":"error","error":"refused"}` or
`data: {"type":"error","error":"grader_error"}`. `verdicts` comes as soon as the model has closed
its verdicts array, a few seconds in, and only when it holds exactly three valid entries. Each
`part` comes as soon as that part's object closes, checked and clipped the same way as in the
JSON reply, only for index 0 to 2. `done` carries the parts from the final parse, which are the
ones to keep. Exactly one `done` or `error` ends the stream; on `error`, drop anything shown so
far. The timeout (110 s) and the refusal behave as in the JSON reply, and `ai_end` runs exactly
once, with status `ok` only when `done` was sent, including when the client disconnects.

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

`node test_prompt.mjs` (no API call) asserts the prompt module's schema (verdicts before parts)
and blocks.
`deno check index.ts` needs the network for the npm imports.
