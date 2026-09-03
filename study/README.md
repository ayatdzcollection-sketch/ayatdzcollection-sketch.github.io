# Study Hub

One page that lists your classes and opens self-contained study materials. Works offline
after the first visit, saves progress in the browser, and syncs between devices with a
short pairing code.

Live at `https://ayatdzcollection-sketch.github.io/study/`.

---

## How access works

**The hub is open.** Anyone with the link can browse and study, no code, no account. That
is the default state of every material.

Materials are still published as **AES-256-GCM ciphertext** (`m/<class>/<name>.enc`) and
the key still comes from the server. That is not to hide them from visitors. The server
hands the key to anyone who asks for an unlocked item. It is what makes **locking** real
and instant: flipping the switch withholds the key immediately, with no republish and no
file to delete, and a stranger holding the `.enc` has nothing but noise.

### The owner

One admin code, entered under **Owner** in the hub, gives you:

| | |
|---|---|
| **Hidden** | The item disappears from everyone else's list. |
| **Locked** | The item stays listed and marked locked, but its key is withheld from everyone but you. This is the one that actually protects it, and the database enforces it, not the page. |
| **Retired** | Still openable, but filed under a collapsed *Retired* heading at the bottom of the hub, for material from an older quiz or assignment. Stored as a `retired` tag on the item (no column, no migration), so it can be set live from the admin panel or with `"retired": true` in `materials.json` before publishing. |

Plus changing codes, seeing how many devices are signed in, and signing them all out.

Codes are checked on the server (bcrypt, cost 12) and stored only as hashes. Ten wrong
tries from one address in fifteen minutes locks that address out for a while. Signing in
stores a 256-bit token the server generated; only its SHA-256 is kept, so a database leak
cannot be replayed as a login. Sessions last 180 days and renew as you use them.

Dashes and capitals in a code are ignored, so type it however is easiest.

The **viewer** code still exists and still works, but grants nothing beyond what a visitor
already gets. It is there if you ever want to close the hub again.

### What this does *not* protect

- **Anything not locked.** That is the point: the default is open.
- **Anything published in plaintext before encryption existed.** The fifty-states quiz was
  served in the clear for a while and remains in this repository's git history. Locking a
  material now cannot un-publish what was already out.
- **A device that already opened a locked item.** Its key is cached there so it works
  offline. Signing out clears the cached keys. The session, the role and the cached keys
  live under `studyhub:auth:*` and are excluded from sync and from backups as a whole
  namespace, so pairing never carries a sign-in or a key to another device.
- Never put anything here that would be damaging if it leaked. This is a study site, not a
  vault.

---

## Adding a material

1. Put the HTML in `src/m/<class>/<name>.html`.
2. Add an entry to `materials.json`.
3. Run the publisher:

```bash
export STUDY_ADMIN_CODE='your-admin-code'
node study/tools/publish.mjs
```

That encrypts each source, writes `m/<class>/<name>.enc`, and registers the material with
its key. Commit the `.enc` files. **Never commit `study/src/`**: it is gitignored.

Losing `src/` is survivable: `node study/tools/publish.mjs --pull` decrypts everything back
out of the published files using your admin code.

### Storage rules for a new material

Use the shared store with your own namespace so two materials can never collide:

```html
<script src="../../assets/sync.js"></script>
<script>
  StudyStore.init({ namespace: 'your-material' });
  StudyStore.set('progress', {...});      // -> studyhub:your-material:progress
  const p = await StudyStore.get('progress');
</script>
```

Always fall back gracefully: if `sync.js` fails to load, write to plain `localStorage`
using the identical key format so no data forks. Copy the adapter from either existing
material.

The publisher rewrites `../../assets/` to `assets/` on the way in, because materials are
served through `view.html` at the hub root. Sources stay openable on their own.

### Registering a merge function

Anything richer than a simple value needs a merge rule, or two devices overwrite each
other. Values without one default to newest-write-wins.

```js
StudyStore.registerMerge('your-material', 'progress', function (a, b, aMtime, bMtime) {
  return { ...a, ...b, best: Math.max(a.best, b.best) };
});
```

**One caveat.** `registerMerge` only applies on pages where your material is loaded. The
hub also merges (on load, on focus, and during a copy-paste import) when your page is
not open. If losing data in that window matters (it does for anything spaced-repetition),
put the rule in `BUILTIN_MERGES` at the top of `assets/sync.js` instead. Every material
that schedules anything does exactly that.

Anything that keeps FSRS records should store them under one `fsrs` key shaped
`{ cards, quizDate, exams }` and register `makeFsrsMerge('cards')` for it, as the periodic
table and the Fraser reading quiz both do. That buys the per-record merge, the exam-log
dedupe and the import preview's summary line with no new code. Editing `sync.js` is a
shell change, so bump `VERSION` in `sw.js` in the same commit.

---

## The For you feed

Every material with a **For you** tab ends that tab with a feed: a column of single cards,
marked the moment you answer, where the next card is not chosen until the last one has been
graded. It is a third door onto the scheduler that material already has, never a second
scheduler, so a run in the feed moves the same numbers a drill session does.

The shape is deliberately the same in all three, and worth keeping that way.

- **Debts first.** A card you miss is queued to come back a few cards later. New material is
  queued up its ladder: shown, then recognised out of four, then produced cold. Queued
  returns outrank the scoring below, so the ladder cannot be starved by whatever happens to
  look urgent.
- **Then urgency.** How far the model's forecast has fallen under the retention target.
  Something never asked enters at a fixed value deliberately placed between *forgetting*
  and *holding*: unseen material beats material that is holding, and loses to material you
  are actively forgetting.
- **Minus interleaving.** Repeating a chapter, a name group, an element, a direction or a
  skill costs points on a sliding scale across the last two to four cards. Prices, not
  prohibitions, so a genuinely urgent card still comes through one.
- **Soft guards.** No card twice inside a window, and a cap on how much new material may
  arrive in a row. Both give way when nothing else qualifies. A guard that can starve the
  feed is worse than no guard: it makes the picker fall back on the card from four minutes
  ago while two hundred unseen ones sit there.
- **A breather every ten answers**, with the tally and a choice to take ten more or stop. A
  feed that never stops is one you scroll rather than answer.
- **Nothing is persisted but the reviews.** The column is in memory. Close the page and the
  cards are gone; what you taught the scheduler is not.

Every card carries the reason it was picked — *Forecast 62% · under the 90% line*, *Never
asked*, *Missed a few cards back*, *Met once · now write it cold*. That line is the feature.
A scheduler that cannot say why it chose something is indistinguishable from a shuffle, and
this one can afford to say.

Algebra 2 adds one rule the others do not need, because its cards are generated rather than
drawn from a bank: three misses in a row on one skill and the feed stops asking, says so,
and points at the guide section for it. A fourth attempt at a skill you have failed three
times is not spaced repetition, it is just failing again.

---

## Sync

Local-first. Every write lands in `localStorage` immediately and nothing waits on the
network. Supabase is a background replica, never the source of truth. The pairing code is a
separate thing from the admin code: one links your own devices, the other is how you sign
in as the owner.

Merging is per field, because last-write-wins would destroy progress the moment a stale
device synced.

| Data | Rule |
|---|---|
| FSRS records (`states`, `cards`) | Per item, keep the record with the larger `last`; tie goes to more `reps`. The whole record travels together, never field by field. |
| `exams` | Concatenate, dedupe by `ts`, keep the newest 20. |
| `tests` | The same rule with a deeper history: newest 40, so a week of drilling cannot evict a graded result. |
| `quizDate` | From whichever side wrote that key more recently. |
| `regionsDone`, `setsDone` | Set union over strings. Legacy: `setsDone` ids encoded a fixed set size. |
| `started` | Set union over numbers. Atomic numbers, so changing the set size cannot orphan progress. |
| `settings` | Field by field, each carrying its own timestamp. A device that touched one switch cannot carry its stale copy of the others back over. |
| Anything else | Newest write wins, unless a merge function is registered. |

Syncs happen on load, when a tab becomes visible, on reconnect, as the page closes, and on
a 25 second throttle while you are studying. Offline changes are flagged and pushed on the
next success. A failed attempt schedules its own retry, backing off from fifteen seconds to
five minutes, because `navigator.onLine` is a hint and not evidence: some devices report
offline while the network is fine, and a device that trusted that would hold its work
forever. A write that lands while a sync is in flight keeps the dirty flag and is sent on
the next pass.

If the hub and a material are open in two tabs, a sync in one raises `change` events in the
other through the `storage` event, so the material never writes a stale copy back over what
just merged in.

Pairing with a code that the server has never seen does not fail; it starts a fresh, empty
sync group. That is what a typo looks like, so the hub says so when it happens.

### What the progress bar can honestly say

A sync is not a stream, so there is no fraction of one to measure. It is three steps: read
the row on the server, merge it with what is on this device, send the result back. The bar
in the sync panel moves in thirds and the line under it names the step, plus the attempt
number when a push conflicted and the merge is being retried. The words are the measurement;
the bar is only a picture of them.

The review-log queue is the opposite case, and genuinely countable, so it reports a real
`sent of total` while it drains.

```bash
node --test "study/tests/*.test.mjs"
```

---

## Review logs

Every material schedules you with a memory model, and the only way to know whether the
model is any good is to compare what it predicted against what happened. With the switch on
(Sync & backup in the hub, or Settings inside the chemistry material) each review queues one
anonymous line and sends it when there is a connection.

| Sent | Not sent |
|---|---|
| Material and card key, which is the question asked (`Na|n2s`, `Ohio`) | Anything you typed |
| Grade, and how long the answer took | Your name, codes, tokens or session |
| Stability, difficulty and predicted retrievability *before* the review | Your IP address |
| Days since the last review, reps, lapses, scheduler version | Anything that identifies a person |

Identity is a random 32-hex install id generated on the device, so one device's stream stays
separable from another's without anyone being named. Clearing site data throws it away.

Local-first, like the rest. Events sit in `studyhub:hub:telemetryQueue` (device-local, never
synced, because copying a queue between devices would send the same reviews twice) and are
flushed in batches of 200 on load, on becoming visible, on being hidden (with keepalive, since
a phone that swipes the app away rarely fires anything later), on reconnect and every five
minutes. The queue is read from storage every time rather than held in memory, so two open
tabs append to one queue instead of overwriting each other; after a send, exactly the events
sent are removed, and the server dedupes on (install, material, card, time) in case two tabs
sent the same batch. A flush keeps sending batches while they succeed rather than stopping
after one: a backlog that built up while `telemetry_ingest` was missing would otherwise have
drained at 200 events per five minutes. A flush triggered by the page going away sends one
batch only, since keepalive buys a single request past the unload and not a conversation. The queue holds 1000 events and drops the **oldest** when it overflows: a
queue that has overflowed has not reached the server in a long while, and the recent reviews
are the ones still worth keeping. The preference itself does sync, because a decision about
your own data should hold on every device you study on.

Turning it off discards whatever is still queued.

**The `telemetry_ingest` function has to exist before anything is stored.** Run
`0004_telemetry.sql` in the Supabase SQL editor. Until then clients get one 404 per page
load, stop trying for that load, and keep queueing. Nothing breaks and nothing is lost.

```sql
-- how well calibrated is the scheduler?
select width_bucket(retrievability, 0, 1, 10) as predicted_decile,
       count(*), avg((grade > 1)::int) as actually_recalled
from study_reviews where retrievability is not null
group by 1 order by 1;
```

---

## Offline and updates

A service worker at the root of this folder (a worker cannot control files above its own
directory) precaches the hub shell and caches material ciphertext as you open things.

**Updates install themselves.** Every page load, every return to the tab, every moment the
device regains a connection, and every three minutes while a tab is open and in front
triggers a version check. Checks are floored at 90 seconds apart however many things ask for
one, the poll skips a backgrounded or offline tab so a phone in a pocket spends nothing on
it, and the worker is registered with `updateViaCache: 'none'` because GitHub Pages serves
`sw.js` with a max-age that would otherwise answer the check from the browser's own cache. When a newer build is found it
is adopted and the page reloads on its own, except while you are typing into a material,
where it waits for a quiet moment instead. The Sync panel also has a manual *Update now*
and a *Clear cache & reload* that recovers from any stuck state.

**Bump `VERSION` in `sw.js` whenever you change a shell file** (`index.html`, `view.html`,
`hub.css`, `hub.js`, `sync.js`, `auth.js`). Material `.enc` files do not need it; they
refresh on their own. The install step fetches the shell with `cache: 'reload'` so a new
worker never precaches the previous build out of the browser's ten minute HTTP cache, and
material revalidation uses `no-cache` so a republish shows up on the next open. A first
visit does not reload itself: `controllerchange` also fires when the first worker claims the
page, and only a change of controller counts as an update. A background tab that hears
about an update waits to reload until it is looked at.

---

## First-time setup

Only needed for a new Supabase project.

1. Run the migrations in order: `0001_study_sync.sql`, `0002_auth.sql`, `0003_public_by_default.sql`.
2. Put the project URL and **publishable** key into the constants at the top of both
   `assets/sync.js` and `assets/auth.js`.
3. Set the two codes, once:

```bash
export STUDY_ADMIN_CODE='...' STUDY_VIEWER_CODE='...'
node study/tools/publish.mjs --bootstrap
```

After that, codes change from the hub's admin panel. `auth_bootstrap` refuses to run a
second time.

---

## Local development

```bash
python3 -m http.server 8000
```

Then `http://localhost:8000/study/`. Add `?offline=1` to any URL to force offline
behaviour; release it with `StudyStore._debug.setOffline(false)` in the console.

---

## Files

| Path | What it is |
|---|---|
| `index.html` | The hub (open to anyone) |
| `view.html` | Fetches, decrypts and runs a material |
| `materials.json` | Source list for the publisher |
| `sw.js` | Service worker: offline cache and self-updating |
| `assets/auth.js` | Sessions, roles, key retrieval, decryption |
| `assets/sync.js` | Shared storage, merge engine, cross-device sync |
| `assets/hub.js` | Hub interface, sync panel, admin controls, QR encoder |
| `tools/publish.mjs` | Encrypt, register, and pull back materials |
| `src/m/**` | Plaintext sources (never committed) |
| `m/**` | Published ciphertext |
| `supabase/migrations/` | Database schema |
| `tests/merge.test.mjs` | Merge rule tests |
