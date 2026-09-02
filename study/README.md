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
put the rule in `BUILTIN_MERGES` at the top of `assets/sync.js` instead. Both existing
materials do exactly that.

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
sent the same batch. The queue holds 1000 events and drops the **oldest** when it overflows: a
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
