# Study Hub

One page that lists classes and launches self-contained study materials. Works offline
after the first visit, saves progress in the browser, and syncs between devices with a
short pairing code.

Live at `https://ayatdzcollection-sketch.github.io/study/`.

---

## Everything in this folder is public

GitHub Pages has no private option. Every file here is readable by anyone who knows or
guesses the URL, and search engines can find it. The code prompt on the site's root page
is a curtain, not a lock — it only hides the list of links.

So:

- **Never put anything here that must not be world-readable.** No personal notes, no
  answer keys you care about, no credentials.
- **The pairing code is the only thing guarding your synced progress.** Never commit it,
  never paste it into an issue, never log it. It lives in your browser's storage and
  nowhere else.
- The Supabase **publishable key** (older projects call it the anon key) in
  `assets/sync.js` is meant to be public — the database denies it all direct table access
  (see *Sync* below). The **secret / service role key** must never appear in this repo, in
  any file, ever.

---

## Adding a material

Two steps. No rebuild, no touching `index.html`.

1. Drop a self-contained HTML file in `m/<class>/`, e.g. `m/apush/reconstruction.html`.
2. Add one entry to `materials.json`.

```json
{
  "classes": [{
    "id": "apush",
    "name": "AP US History",
    "term": "2026-27",
    "materials": [{
      "id": "reconstruction",
      "title": "Reconstruction — amendments and dates",
      "blurb": "Short answer drill with spaced repetition.",
      "path": "m/apush/reconstruction.html",
      "tags": ["dates", "quiz"],
      "added": "2026-09-14"
    }]
  }]
}
```

If the JSON is malformed or a `path` is unusable, the hub shows a readable error naming
the problem instead of a blank page.

### Storage rules for a new material

Load the shared module and use your own namespace, so two materials can never collide on
a key name:

```html
<script src="../../assets/sync.js"></script>
<script>
  StudyStore.init({ namespace: 'reconstruction' });
  await StudyStore.set('progress', {...});   // stored as studyhub:reconstruction:progress
  const p = await StudyStore.get('progress');
</script>
```

Always degrade gracefully — if `sync.js` fails to load, fall back to plain `localStorage`
using the same key format (`studyhub:<namespace>:<key>`) so no data forks. See the adapter
in `m/apush/fifty-states.html` for the pattern.

### Registering a merge function

Anything beyond a simple value needs a merge rule, or two devices will overwrite each
other. Values without one default to newest-write-wins.

```js
StudyStore.registerMerge('reconstruction', 'progress', function (a, b, aMtime, bMtime) {
  return { ...a, ...b, score: Math.max(a.score, b.score) };
});
```

**One caveat.** `registerMerge` only takes effect on pages where your material is loaded.
The hub also merges — on page load, when the tab regains focus, and during a copy-paste
import — and at those moments your material's page is not open. If losing data in that
window matters (it does for anything spaced-repetition), put the merge in `BUILTIN_MERGES`
near the top of `assets/sync.js` instead. That is the one case where adding a material
means editing a file other than `materials.json`. The fifty-states merges live there for
exactly this reason.

---

## Sync

Local-first. Every write lands in `localStorage` immediately and the interface never waits
on the network. Supabase is a background replica, never the source of truth.

### One-time setup

Already done for the **study system** project; repeat this only for a new project.

1. In the Supabase dashboard, open the SQL editor and run
   `supabase/migrations/0001_study_sync.sql`. It is safe to re-run.
2. Copy the project URL and the **publishable** (anon / public) key from
   Project Settings → API keys.
3. Paste both into the two constants at the top of `assets/sync.js`:

```js
var SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_...';
```

Leave them empty and everything still works except pairing — local saving, offline, and
the copy-paste backup are all independent of Supabase. If the functions are missing the
Sync panel says so in plain words rather than failing silently.

A free Supabase project pauses after a stretch of inactivity; the first sync after that
may need a retry while it wakes.

### How pairing works

One device creates a code (60 bits of randomness, shown as `K7Q2-9MXR-4B8T` and as a
scannable square). The other device types or scans it. Both then read and write one row,
found by the SHA-256 hash of the code. The code itself never reaches the server.

The database denies the anon key all direct table access — row level security is on with
no policies. The only way in is two `SECURITY DEFINER` functions that require knowing the
code: `sync_pull` and `sync_push`. Guessing is guarded two ways: 60 bits is about 1.15e18
possibilities, and a per-IP counter rejects an address after 30 failed lookups in an hour.

`sync_push` uses optimistic concurrency, not last-write-wins: it only writes if the row
still carries the `updated_at` the client last saw, otherwise it returns the current row
so the client re-merges and retries.

### Merge rules

Merging happens per field, because naive last-write-wins destroys data here — study on
your phone, open your laptop, and a stale copy would wipe the phone's work.

| Data | Rule |
|---|---|
| `fsrs.states` | Per state, keep the record with the larger `last`; tie goes to more `reps`. The whole record travels together — never field by field. |
| `fsrs.exams` | Concatenate, dedupe by `ts`, sort, keep the newest 20. |
| `fsrs.quizDate` | From whichever side wrote that key more recently. |
| `regionsDone` | Set union. |
| Anything else | Newest write wins, unless a merge function is registered. |

Run the tests with:

```bash
node --test "study/tests/*.test.mjs"
```

### When it syncs

On page load, when a tab becomes visible, on reconnect, as the page closes, and on a 25
second throttle while you are actively studying. Never on every keystroke. Offline changes
are flagged and pushed on the next successful sync.

---

## Copy-and-paste backup

In the hub's Sync panel. Export produces one string covering every material
(`SH1:` compressed, or `SH0:` if the browser lacks compression). Import runs the same merge
and shows what would change before committing — it never blindly overwrites. Works with no
network and no Supabase configured at all.

---

## Offline

A service worker (`sw.js`, at the root of this folder because a worker cannot control
files above its own directory) precaches the hub and every listed material.

- `materials.json` is fetched network-first, so new entries appear without clearing anything.
- Material HTML is served from cache immediately and refreshed in the background.
- Google Fonts used by the quiz are cached after the first online visit; the fallback font
  stacks cover the cold-offline case.

**Bump `VERSION` in `sw.js` whenever you change `index.html`, `hub.css`, `hub.js`, or
`sync.js`.** Without a bump, browsers keep serving the cached copy. The Sync panel has an
*Update now* button when a new version is waiting, and a *Clear cache & reload* button that
recovers from any stuck state.

---

## Local development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/study/`. To simulate two devices, serve the same folder on
a second port — different origins get separate storage:

```bash
python3 -m http.server 8001
```

Add `?offline=1` to any URL to force offline behaviour, and release it from the console
with `StudyStore._debug.setOffline(false)`.

---

## Files

| Path | What it is |
|---|---|
| `index.html` | The hub |
| `materials.json` | The list of classes and materials — the only file you edit to add one |
| `sw.js` | Service worker (offline cache) |
| `assets/sync.js` | Shared storage, merge engine, and sync |
| `assets/hub.js` | Hub interface, sync panel, QR encoder |
| `assets/hub.css` | Hub styles |
| `assets/app.webmanifest` | Home-screen install |
| `m/apush/fifty-states.html` | The 50-states quiz |
| `supabase/migrations/` | Database schema |
| `tests/merge.test.mjs` | Merge rule tests |
