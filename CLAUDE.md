# Jacykow.github.io — notes for whoever works on this next

Jacek Gulij's personal site, served by GitHub Pages from this repository at
<https://www.gulij.com> (the `CNAME` file is what points the domain here).
**There is no build step.** What is committed is what is served, so a change to
a file here is a change to the live site.

```bash
node serve.js          # the whole site on http://localhost:5173
```

## Git, before anything else

Branch and commit freely. **Never push and never merge to `main`** — Jacek
reviews `git diff main..<branch>` and does both himself. Work on Random Engine
lives on the `random-engine` branch.

Commit messages carry the *why*: he reads changes as a diff, so the reasoning
that is not visible in the code belongs in the message.

## What is here

| Path | What it is |
|---|---|
| `index.html` | the portfolio page — one hand-written file |
| `frontend/index.bundle.css`, `frontend/index.bundle.js` | its styles and script, **bundled output**; the sources are not in this repository |
| `frontend/resources/` | images and video for the portfolio |
| `random/` | **Random Engine**, a self-contained dice-notation console at `/random/`. It has its own `CLAUDE.md` and `README.md` — read those before touching anything in it |
| `serve.js` | a small static server for local work. Development only; it is never run in production |
| `CNAME`, `ads.txt`, `app-ads.txt` | domain and ad-network verification files. Leave them alone |
| `LICENSE` | the repository licence |
| `black-iris-license/`, `golden-rails-license/`, `ice-master-license.pdf` | licence pages served for individual games |

`frontend/index.bundle.*` are minified build artefacts with no sources here.
Editing them by hand is possible but is editing generated code — say so plainly
if you do, rather than presenting it as an ordinary change.

## Documentation, and what it is for

Every document here is written as though everything was always this way. No
change history, no future plans, no "recently added" — those belong in commit
messages, which is where Jacek reads them. Keep documents brief and say the
things that are not obvious from the code; anything the code already says
plainly does not need saying twice.

`random/README.md` is the exception in kind rather than in style: it is the
user-facing specification of the dice notation, written for people *and* for
whatever reads it next, and it is meant to be complete.
