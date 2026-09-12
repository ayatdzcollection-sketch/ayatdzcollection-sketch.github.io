# ayatdzcollection-sketch.github.io

Personal site, served at `https://ayatdzcollection-sketch.github.io/`.

Plain static files: no Jekyll, no build step. `.nojekyll` is present so files pass through
untouched, including self-contained HTML with inline scripts.

| Path | What it is |
|---|---|
| `index.html` | Root landing page, behind the same code prompt as the hub |
| `study/` | [Study Hub](study/README.md): encrypted class materials, offline-capable, synced |

## Access

Both this page and the hub share one session. Enter a code once and this browser stays
signed in; other browsers do not. Codes are verified by Supabase, never by this page, and
exist there only as bcrypt hashes.

There are two: a **viewer** code, and an **admin** code that can additionally hide or lock
materials, change either code, and sign every other device out.

**What the code does and does not do.** GitHub Pages serves every file publicly, so the
prompt cannot stop anyone reaching a URL. What protects the study materials is that they
are published as AES-256-GCM ciphertext and the key is released only to a signed-in
browser. The prompt on this page just decides whether to show you the list.

Do not put anything in this repository that would be damaging if it leaked. Files that
were ever committed in plaintext remain in the git history.

Setup and day-to-day instructions live in [study/README.md](study/README.md).
