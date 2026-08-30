# ayatdzcollection-sketch.github.io

Personal site, served at `https://ayatdzcollection-sketch.github.io/`.

Plain static files — no Jekyll, no build step. `.nojekyll` is present so files pass through
untouched, including self-contained HTML with inline scripts.

| Path | What it is |
|---|---|
| `index.html` | Root landing page, behind a code prompt |
| `study/` | [Study Hub](study/README.md) — class materials, offline-capable, synced |

## The root code prompt

`index.html` asks for a code before listing what is published here. It stores only the
code's SHA-256 hash, never the code.

**It is a curtain, not a lock.** GitHub Pages serves every file publicly; anyone with a
direct URL reaches it without ever seeing the prompt. It only keeps the root page from
advertising what exists. Never put anything in this repository that must not be
world-readable.

To change the code, replace the `CODE_HASH` value in `index.html` with a new SHA-256 hex
digest of the uppercased, dash-stripped code:

```bash
printf '%s' 'YOURNEWCODE' | shasum -a 256
```
