# Random Engine

A lightweight, dependency-free web console for advanced dice notation — with the UX of
[regexr.com](https://regexr.com): you type an expression, it is syntax-highlighted live,
broken down token-by-token in an **Explain** panel that stays linked to your caret, and
rolled as you type.

No build step, no dependencies, no network calls. Four files and a 25-line dev server.
Designed for phones as much as desktop.

**Live: <https://www.gulij.com/random>**

```bash
node serve.js
```

Then open <http://localhost:5173>. (Opening `index.html` directly via `file://` also works.)

---

## Where the notation comes from

The syntax is the one popularised by the Discord dice bots — **Sidekick** and
**Dice Maiden** — in the form later formalised by
[rpg-dice-roller](https://dice-roller.github.io/documentation/), which is the most
complete and least ambiguous version of that family. A few Dice Maiden shorthands
(`e6`, `ie6`, `t8`, `f1`) are accepted as aliases on top.

## Syntax

### Dice

| Notation | Meaning |
|---|---|
| `d20` | one twenty-sided die |
| `4d6` | four six-sided dice, summed |
| `d%` | percentile die (1–100) |
| `dF`, `dF.1` | Fudge / FATE die: −1, 0 or +1 |
| `(2+2)d6` | computed quantity |
| `3d(2*6)` | computed number of sides |

### Modifiers

Modifiers chain onto a dice term in any written order — they are always **applied** in the
fixed order below, so `4d6kh3!` and `4d6!kh3` mean the same thing.

| # | Notation | Meaning |
|---|---|---|
| 1 | `min2` | any roll below 2 counts as 2 |
| 2 | `max5` | any roll above 5 counts as 5 |
| 3 | `!` | exploding: re-roll and add on the highest face |
| 3 | `!>4`, `!=6`, `!6` | explode on a specific comparison |
| 3 | `!!` | compounding: the extra roll folds into the same die |
| 3 | `!p`, `!!p` | penetrating: every extra roll takes −1 |
| 3 | `e6` / `ie6` | Dice Maiden: explode once / repeatedly on 6+ |
| 4 | `r`, `r<3`, `r1` | re-roll until the die no longer qualifies |
| 4 | `ro`, `ro1` | re-roll at most once |
| 5 | `u`, `uo` | force unique results (`uo` re-rolls duplicates once) |
| 6 | `kh3`, `k3`, `kl1` | keep the highest / lowest N |
| 7 | `dl1`, `dh1` | drop the lowest / highest N |
| 8 | `>=8`, `t8` | stop summing; count each qualifying die as a success |
| 8 | `f<=1`, `f1` | each qualifying die cancels one success |
| 9 | `cs>=19` | flag critical successes (display only) |
| 10 | `cf<=2` | flag critical failures (display only) |
| 11 | `s`, `sa`, `sd` | sort the dice ascending / descending |

Comparison points are `=`, `!=`, `<`, `>`, `<=`, `>=`. A bare number after `!`, `r`, `ro`,
`u`, `uo`, `cs` or `cf` means "equal to" (`r1` == `r=1`); after `f` it means "or less"
(`f1` == `f<=1`), matching Dice Maiden.

### Groups

```
{2d6, 3d8}            roll both, sum the totals
{4d6, 2d10, d4}kh1    keep only the best sub-roll
{3d6+2d8}kh3          one sub-roll: keep the best 3 dice across the whole group
{2d6, 3d8}>=9         count sub-rolls of 9 or more as successes
```

Group modifiers are `kh`/`kl`/`dh`/`dl`, target success/failure, and sorting. With several
sub-rolls they act on whole sub-roll totals; with a single sub-roll they act on the
individual dice inside it.

### Maths

`+ - * / % ^` (or `**`), parentheses, and the functions `abs ceil cos exp floor log max min
pow round sign sin sqrt tan`. `round()` rounds half away from zero.

```
(1d6+2)*3        floor(3d6/2)        max(1d20, 1d20)
```

### Whole-roll extras

```
6x 4d6dl1               roll the entire expression 6 times and report each set
2d20kh1+5 # attack      everything after # is a label, ignored by the maths
```

## Interface

* **Expression** — live syntax highlighting. Errors underline the field and the status
  line names the position.
* **Result** — the top card re-rolls as you type; <kbd>Enter</kbd> freezes it and rolls
  again, building a log. Dropped dice are struck out, exploded dice are amber, re-rolled
  dice show their original value, successes and criticals are colour-coded.

  Each die is a 3D render of its actual solid: tetrahedron, cube, octahedron, pentagonal
  trapezohedron, dodecahedron, icosahedron, a coin for `d2` and a zocchihedron for `d%`.
  Only those sizes have a standard shape, so Fudge dice and everything else (`d3`, `d7`,
  …) show a plain value instead of inventing a solid. The shapes are one inline SVG
  sprite referenced with `<use>`, so they cost no extra requests and recolour from CSS.

  Dice shrink as the count grows — 34px, then 26px past 18 dice, then 19px past 60 — and
  past 240 dice they fall back to plain text chips so typing never stalls. Those
  thresholds live in `DENSITY` at the top of `app.js`.
* **Explain** — one row per token. Click a row to select that token in the field; moving
  the caret highlights the matching row.
* **Details** — Monte-Carlo distribution of the total (min / mean / median / max / std dev
  / percentiles) with a histogram. Sample size adapts to keep it responsive.
* **Reference** — the full cheat sheet; click any snippet to insert it at the caret.
* **Saved** — expressions kept in `localStorage`. <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.
* **Copy link** — puts the expression in the URL hash so it can be shared.

The tool drawer collapses to just its tab strip via the chevron on the right, handing the
full screen to the results — worth it on a phone. The choice is remembered. Layout uses
`dvh` units and safe-area insets, so browser chrome, the on-screen keyboard and notches
don't clip it.

## Files

| File | Purpose |
|---|---|
| `engine.js` | tokenizer, recursive-descent parser, evaluator, explainer. No DOM. |
| `app.js` | UI: highlighting, caret sync, result log, tools, storage. |
| `index.html`, `style.css` | markup and theme |
| `tools/gen-dice.js` | builds the dice art (see below) |
| `tools/splice.js` | regenerates and writes it into `index.html` + `style.css` |
| `serve.js` | minimal static dev server |

### The dice art

`tools/gen-dice.js` builds each die's real polyhedron from its vertices and derives the
faces as a convex hull. Every solid is then laid to rest on a face — that face's normal
points at the floor — spun about the vertical until its silhouette is symmetric, and
viewed through **one shared camera** (`PITCH`), so the perspective is identical across
the whole set and every die has a surface flat on the ground. Back faces are culled and
the rest shaded with a Lambert term. The result is baked into the SVG sprite; there is
no 3D at runtime, just static paths.

The value goes on the face lying flat on top — except the tetrahedron, which has no such
face: the element opposite its resting face is a single vertex. Real d4s solve this by
printing the value beside that tip on each surrounding face, and the generator does the
same.

Faces are painted with `currentColor` at a baked opacity over an opaque body, which is
why one CSS colour still drives every roll state. The generator also emits each shape's
`--nx` / `--ny` / `--nsz`, positioning the value on the face aimed at the camera.

Do not hand-edit the sprite or the generated CSS block. Change the generator and run:

```bash
node tools/splice.js
```

`engine.js` exposes `window.DiceEngine`:

```js
DiceEngine.roll('4d6dl1')      // → { total, notation, label, sets: [...] }
DiceEngine.inspect('4d6dl1')   // → { spans, rows, notation }  (highlight + explain)
DiceEngine.analyse('4d6dl1')   // → { min, max, mean, median, stdev, p10, p90, totals }
DiceEngine.parse('4d6dl1')     // → { ast, repeat, label, ... }
```

Randomness comes from `crypto.getRandomValues`, falling back to `Math.random`.
Guard rails: 5,000 dice per term, 20,000 per expression, 500 chained explosions or
re-rolls per die.
