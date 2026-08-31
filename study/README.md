# Study Hub

One page that lists your classes and opens self-contained study materials. Works offline
after the first visit, saves progress in the browser, and syncs between devices with a
short pairing code.

Live at `https://ayatdzcollection-sketch.github.io/study/`.

---

## How access actually works

GitHub Pages hands every file to anyone who asks for it. There is no server standing in
front of it that could check a password first. So the protection here is **cryptographic,
not positional**:

- Every material is published as **AES-256-GCM ciphertext** (`m/<class>/<name>.enc`).
  Fetching that URL without a key gives you noise.
- The key lives in Supabase and is released only to a browser holding a valid session.
- A session comes from entering a code. Codes are checked **on the server** (bcrypt, cost
  12) and stored only as hashes. Ten wrong tries from one address in fifteen minutes and
  that address is locked out for a while.
- Signing in stores a 256-bit token the server generated. Only its SHA-256 is kept in the
  database, so a database leak cannot be replayed as a login. The session lasts 180 days
  and renews itself whenever you use it, so a device you use stays signed in.

### Two codes

| Role | Can do |
|---|---|
| **Viewer** | Open everything that is neither hidden nor locked. |
| **Admin** | Everything a viewer can, plus: hide or lock any item, change either code, see how many devices are signed in, and sign them all out. |

**Hidden** keeps an item off the list. **Locked** additionally withholds its decryption
key — that is the one that actually stops someone reading it, and it is enforced by the
database, not by the page.

### What this does *not* protect

- **Anything published in plaintext before encryption existed.** The fifty-states quiz was
  served in the clear for a while, and this repository's git history still contains it.
  Locking a material now hides it going forward; it cannot un-publish what was already out.
- **Which materials exist.** Ids, file sizes and timings are visible to anyone.
- **An unlocked device.** Once a material is opened, its key is cached locally so it works
  offline. Whoever holds that phone holds that material. "Sign out of this device" in the
  Sync panel clears the cached keys.
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
network. Supabase is a background replica, never the source of truth. Pairing is separate
from your access code: one links your devices, the other unlocks the hub.

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

1. Run `supabase/migrations/0001_study_sync.sql`, then `0002_auth.sql`, in the SQL editor.
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
| `index.html` | The hub, behind the code prompt |
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
