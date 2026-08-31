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
the key still comes from the server. That is not to hide them from visitors — the server
hands the key to anyone who asks for an unlocked item. It is what makes **locking** real
and instant: flipping the switch withholds the key immediately, with no republish and no
file to delete, and a stranger holding the `.enc` has nothing but noise.

### The owner

One admin code, entered under **Owner** in the hub, gives you:

| | |
|---|---|
| **Hidden** | The item disappears from everyone else's list. |
| **Locked** | The item stays listed and marked locked, but its key is withheld from everyone but you. This is the one that actually protects it, and the database enforces it — not the page. |

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
  offline. Signing out clears the cached keys.
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
its key. Commit the `.enc` files. **Never commit `study/src/`** — it is gitignored.

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
hub also merges — on load, on focus, and during a copy-paste import — when your page is
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
| `quizDate` | From whichever side wrote that key more recently. |
| `regionsDone`, `setsDone` | Set union. |
| Anything else | Newest write wins, unless a merge function is registered. |

Syncs happen on load, when a tab becomes visible, on reconnect, as the page closes, and on
a 25 second throttle while you are studying. Offline changes are flagged and pushed on the
next success.

```bash
node --test "study/tests/*.test.mjs"
```

---

## Offline and updates

A service worker at the root of this folder (a worker cannot control files above its own
directory) precaches the hub shell and caches material ciphertext as you open things.

**Updates install themselves.** Every page load, every return to the tab, and every moment
the device regains a connection triggers a version check. When a newer build is found it
is adopted and the page reloads on its own — except while you are typing into a material,
where it waits for a quiet moment instead. The Sync panel also has a manual *Update now*
and a *Clear cache & reload* that recovers from any stuck state.

**Bump `VERSION` in `sw.js` whenever you change a shell file** (`index.html`, `view.html`,
`hub.css`, `hub.js`, `sync.js`, `auth.js`). Material `.enc` files do not need it; they
refresh on their own.

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
| `index.html` | The hub — open to anyone |
| `view.html` | Fetches, decrypts and runs a material |
| `materials.json` | Source list for the publisher |
| `sw.js` | Service worker: offline cache and self-updating |
| `assets/auth.js` | Sessions, roles, key retrieval, decryption |
| `assets/sync.js` | Shared storage, merge engine, cross-device sync |
| `assets/hub.js` | Hub interface, sync panel, admin controls, QR encoder |
| `tools/publish.mjs` | Encrypt, register, and pull back materials |
| `src/m/**` | Plaintext sources — never committed |
| `m/**` | Published ciphertext |
| `supabase/migrations/` | Database schema |
| `tests/merge.test.mjs` | Merge rule tests |
