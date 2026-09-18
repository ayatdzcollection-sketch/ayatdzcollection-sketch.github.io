# study-ask: ask about the material

One Supabase Edge Function beside `saq-grade`. A student highlights text or types a question in a
material tagged `ai-ask`; the material sends what is on screen, the highlight, the passages it
picked, the student's progress and saved notes, and the question. The function asks Postgres for
permission and a budget (`ai_begin2`, feature `ask`), streams one Claude answer back as Server Sent
Events with the prompt in `ask_prompt.mjs`, closes the ledger row (`ai_end`) exactly once,
including when the student closes the page halfway, and saves the question and the answer as one
row in `study_ai_chats` (`ai_chat_log`, see Saved chats below).

It is **owner only** while the `ask` row in `study_ai_features` has `mode = 'owner'`, which is how
0011 creates it: every call without the owner's admin token answers `owner_only`. The row also
starts with `enabled = false`, so until the owner turns it on every call answers `off`. Run
`0010_ai_grading.sql`, `0011_ai_features.sql` and `0012_ai_chats.sql` first.

## Request

`POST /functions/v1/study-ask` with the public key in `apikey` and `Authorization: Bearer`, an
`Origin` header of `https://ayatdzcollection-sketch.github.io` or `http://localhost:8000` (anything
else, or no header, is refused with 403), and a JSON body:

```
{
  material:   'apush/period1-2-test',          required, ^[a-z0-9-]+/[a-z0-9-]+$, at most 120
  install:    '<32 lowercase hex>',            required
  adminToken: '<owner session token>',         optional, at most 128, needed in owner mode
  question:   'explain',                       required, 1 to 600
  quote:      'the highlighted text',          optional, 0 to 1200
  focus:      'what is on the screen',         optional, 0 to 2500
  map:        'outline of the material',       optional, 0 to 9000
  chunks:     [{ label, text }],               optional, at most 14; label 0 to 80, text 0 to 2000,
                                               all text together at most 16000
  history:    [{ role: 'user'|'assistant', text }]   optional, at most 6; text 0 to 1500
  progress:   'forecast, weak sections, ...',  optional, 0 to 3000
  notes:      'what the student saved',        optional, 0 to 1500
  thread:     'conversation id',               optional, ^[a-z0-9-]{8,64}$
  turn:       2                                optional, integer 0 to 100
}
```

Lengths are counted after trimming, except `thread`, which must match as sent. A field that is
present must have the right type (send an empty string or leave it out, not `null`). `thread` is
stored as null and `turn` as 0 when they are left out. The raw body is capped at 327680
characters. Anything outside these rules is `400 {ok:false, error:'bad_request'}` before any
ledger row is opened.

`progress` is the student's own record in this material (forecast, mock tests, weakest sections,
questions they keep missing, short answer parts not earned) and `notes` are things the student
saved earlier. They go into the question message as `PROGRESS` and `NOTES` blocks, in that order,
before `FOCUS`, each left out when empty. The prompt uses progress only when the question is about
the student, follows notes that state a preference, and ends an answer with a last line
`Remember: <one sentence>` only when the question itself asks to remember or note something.

Passage numbers are the 1 based position in `chunks` as sent, so `Sources: [2]` in an answer
means `chunks[1]`. A chunk with empty text is skipped without renumbering the others. Keep `map`
the same for every question in a material: it is the cached part of the prompt.

## Response

**Refused before any spend**: `200`, `Content-Type: application/json`, `{ ok: false, error }`.

**Accepted**: `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`.
Each event is one line `data: <json>` followed by a blank line. No other event types, comments or
`event:` lines are sent.

```
data: {"type":"delta","text":"..."}            zero or more, in order; append them
data: {"type":"done","model":"claude-sonnet-4-6","cost_cents":0.412,"chat_id":123}
```

`chat_id` is the `study_ai_chats` row the answer was saved as, for rating it later with
`ai_chat_rate`. It is left out when the row could not be written; the answer is not affected.

or, when something fails after the stream opened, instead of `done`:

```
data: {"type":"error","error":"grader_error"}
data: {"type":"error","error":"refused"}
```

Exactly one `done` or `error` event ends every stream, then the stream closes. Deltas may already
have arrived before an `error`; drop the partial text. An answer cut off by the 700 token cap still
ends with `done`. The answer's last line is `Sources: [n], [n]` when passages were used.

## Error codes

| Code | Where | Meaning |
|---|---|---|
| `bad_request` | 400 JSON | The body failed validation. |
| `forbidden` | 403 JSON | Missing or unknown `Origin`. |
| `method_not_allowed` | 405 JSON | Not POST or OPTIONS. |
| `off` | 200 JSON | The master switch or the `ask` row is off. |
| `unavailable` | 200 JSON | The material does not carry the feature's tag (`ai-ask`). |
| `owner_only` | 200 JSON | The row is in owner mode and the token is not the owner's. |
| `no_model` | 200 JSON | The row's model is missing or disabled in `study_ai_models`. |
| `monthly_cap`, `daily_cap` | 200 JSON | The global ceilings in `study_ai_settings`. |
| `feature_cap` | 200 JSON | The `ask` row's own `daily_cents`. |
| `bad_install`, `device_cap`, `slow_down` | 200 JSON | Open mode only: install id, per device and per address limits. |
| `rejected` | 200 JSON | `ai_begin2` itself failed. |
| `grader_error` | 200 JSON or SSE | Configuration missing, the database call failed, the Claude call failed or timed out (60 s). Never carries the API's own text. |
| `refused` | SSE | The model declined (`stop_reason: refusal`). |

## Ledger

`ai_begin2('ask', material, install, ip, adminToken, p_in, 700)` holds a reserve, where `p_in` is
`ceil(characters of the system blocks and messages / 3.5)`. `ai_end(call_id, status, in, out,
latency)` then records `ok`, `refused` or `error` with input counted at what it cost:
`input + 1.25 x cache writes + 0.1 x cache reads`. A stream cut short (client gone, timeout, API
error mid stream) records the tokens reported so far, or 0 when none were. The ip is the last
`x-forwarded-for` entry. The input reserve counts every character sent, `progress` and `notes`
included; `RESERVE_IN` (8300) is only the fallback. The ledger itself holds no text.

## Saved chats

Ask is an owner only beta, and its questions and answers are now stored so it can be improved:
once per call, after the answer has finished or failed, the function calls
`ai_chat_log(p_row)` (service role only, from `0012_ai_chats.sql`) with

```
{ call_id, material, feature: 'ask', install, thread, turn, question, quote,
  focus (clipped to 2500), labels (every chunk label, in the order sent),
  progress: true|false, notes: true|false (whether each was sent, not the text),
  answer (the full text produced, or what streamed before a refusal or failure),
  status: 'ok'|'refused'|'error', model, input_tokens (effective, as for ai_end),
  output_tokens, cost_microcents (tokens times the PRICES rate times 1e8), latency_ms }
```

On an answer that finished the row is written before `done` is sent and its id comes back as
`chat_id`. On a refusal, an error, a timeout or a client that left, the row is written after
`ai_end`, best effort. A failed write logs one fixed line and never changes what the student gets.
The rows are readable only through `admin_ai_chats` with the owner's token, and `ai_chat_rate`
marks one helpful or not. If Ask ever opens beyond the owner, revisit the privacy row in
`study/README.md` first. The function logs no question, passage or answer text.

## Models

The model comes from the `ask` row. `claude-sonnet-4-6` (the default) and `claude-haiku-4-5` get no
thinking parameter. `claude-sonnet-5`, `claude-opus-5` and `claude-opus-4-8` get
`output_config: { effort: 'low' }`, as does any id not listed. Sonnet 5 and Opus 5 think adaptively
when `thinking` is left out, and that thinking counts against the 700 token cap; low effort keeps it
short. Prices come from `../saq-grade/grader_prompt.mjs`.

## Deploy

The function shares the `ANTHROPIC_API_KEY` secret with `saq-grade`; one secret serves both. The
script beside the grader sets it once and deploys both functions, writing neither secret to disk:

    export SUPABASE_ACCESS_TOKEN=sbp_...
    export ANTHROPIC_API_KEY=sk-ant-...
    sh study/supabase/functions/saq-grade/deploy.sh

Or this function alone, from the repo root, once the secret is set:

    npx supabase@latest functions deploy study-ask --project-ref gyfqhkhgosjpyvatffbi --workdir "$PWD/study"

Use the CLI, not the dashboard editor: `ask_prompt.mjs` imports the price table from
`../saq-grade/grader_prompt.mjs`, and the CLI bundles that file by following the import. Leave
"Verify JWT" on; the material sends the public key. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
are injected by the platform.

## Smoke test

```bash
curl -sN -X POST "https://gyfqhkhgosjpyvatffbi.supabase.co/functions/v1/study-ask" \
  -H "apikey: sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb" \
  -H "Authorization: Bearer sb_publishable_q-_2MgYpTJB-OeGGIy8EzA_8mvRB1nb" \
  -H "Origin: http://localhost:8000" -H "Content-Type: application/json" \
  -d '{"material":"apush/period1-2-test","install":"0123456789abcdef0123456789abcdef","question":"explain"}'
```

Expected while the feature is off: `{"ok":false,"error":"off"}`. On, in owner mode, without a
token: `{"ok":false,"error":"owner_only"}`. Without the Origin header: 403.

## Local check

`node test_prompt.mjs` (no API call) asserts the request shape, cache placement, block order
(PROGRESS and NOTES first), history merging, model params, the validation limits for every field
including `progress`, `notes`, `thread` and `turn`, the appended PROGRESS, NOTES and Remember
instructions, and that the prompt has no em or en dash. Its trap notes block asserts the trap
limits, prompt rules, request shape, model params, validation and note cleaning, and that
`trapNote` in `index.ts` spends against `trap` and closes the ledger.
`deno check index.ts` needs the npm SDK in the Deno cache.

## Trap notes (purpose `trap`, migration 0025)

When a student keeps picking the same wrong option on a multiple choice card, the page asks this
function once, ever, for that card: two lines from the material's own passages, why that option
looks right and the thing that rules it out. The page keeps the note with the student's progress
under `trapnotes` (merged per card by `assets/sync.js`) and shows it under the why line on every
later review, with no further call. It is its own row in `study_ai_features` (`trap`, "Trap
notes"), created by `0025_ai_trap.sql` off, in owner mode, on Ask's model, with a 10 cent daily cap
and Ask's tag, so it runs wherever Ask is tagged and only once the owner switches it on in the
panel. Run 0025 before a page asks for one; until then every trap request answers `off`.

Request: the same endpoint and headers as an Ask question, with this body.

```
{
  purpose:    'trap',                           required; no purpose, or 'ask', is an Ask question,
                                                any other purpose is a 400
  material, install, adminToken                 as for Ask
  question:   'the card as asked',              required, 1 to 600
  options:    ['...', '...'],                   required, 2 to 6, each 1 to 300
  picked:     0,                                required, the option kept being picked (an index)
  answer:     1,                                required, the key (an index); must differ from picked
  why:        'the card's own why line',        optional, 0 to 800
  chunks:     [{ label, text }]                 optional, at most 4; label 0 to 80, text 0 to 1500,
                                                all text together at most 6000
}
```

`ai_begin2('trap', ...)` holds the reserve against the `trap` row's own cap, never Ask's. One call,
not streamed, 30 seconds, no retry, with the fixed prompt `TRAP_SYSTEM` in `ask_prompt.mjs` (two
lines starting "Looks right:" and "Ruled out:", under 60 words, only from what was sent, the
numbers rule and the no dashes rule of the Ask prompt). `max_tokens` is 200. Sonnet 4.6 and Haiku
4.5 get nothing else; Sonnet 5, Opus 5 and Opus 4.8 get `thinking: { type: 'disabled' }` and
effort low, so thinking cannot spend the 200; a model id not listed keeps effort low and gets 600.
`cleanTrapNote` keeps the reply only in that two line shape, drops stray tags, bold and bullets,
turns a dash between numbers into "to" and any other em or en dash into a comma, and holds each
line to 180 characters. `ai_end` closes the ledger row once, and one `study_ai_chats` row is
written after it, best effort, with `feature: 'trap'` (the question, the option kept being picked
as the quote, the key and why line as the focus, the passage labels and the note).

Response, always JSON:

```
{ ok: true, note: 'Looks right: ...\nRuled out: ...', model, cost_cents }
{ ok: false, error, spent: true, cost_cents }     billed: 'refused', or 'bad_note' (a reply that
                                                  was not two lines); the page stores a marker so
                                                  the card is never paid for again
{ ok: false, error }                              nothing spent: every ai_begin2 refusal above,
                                                  'bad_request', or 'grader_error'
```
