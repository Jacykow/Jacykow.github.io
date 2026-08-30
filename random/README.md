# Random Engine

A lightweight, dependency-free web console for advanced dice notation — with the UX of
[regexr.com](https://regexr.com): you type an expression, it is syntax-highlighted live,
broken down token-by-token in an **Explain** panel that stays linked to your caret, and
previewed as the dice it would throw.

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
(`e6`, `f1`) are accepted as aliases on top, and the repeat modifiers were regularised
into the `e`/`ei`, `r`/`ri` pairs described below.

## Syntax

### Dice

| Notation | Meaning |
|---|---|
| `d20` | one twenty-sided die |
| `4d6` | four six-sided dice, summed |
| `(2+2)d6` | computed quantity |
| `3d(2*6)` | computed number of sides |

### Modifiers

Modifiers chain onto a dice term in any written order — they are always **applied** in the
fixed order below, so `4d6kh3e` and `4d6ekh3` mean the same thing. A term may only carry
one explode modifier.

Anything that can repeat follows one rule: **the plain letter does it once, a trailing
`i` does it for as long as it keeps qualifying** — `e` / `ei`, `r` / `ri`. `u` is exempt:
it narrows the set of allowed values rather than repeating a roll.

| # | Notation | Meaning |
|---|---|---|
| 1 | `min2` | any roll below 2 counts as 2 |
| 2 | `max5` | any roll above 5 counts as 5 |
| 3 | `e` | exploding: roll again and add on the highest face |
| 3 | `e5`, `e>=5` | explode on a comparison |
| 3 | `ei`, `epi` | the same, repeated while it keeps qualifying |
| 3 | `ep` | penetrating: every extra roll takes −1 |
| 4 | `r`, `r2`, `r<=2` | re-roll once |
| 4 | `ri`, `ri2` | re-roll until it no longer qualifies |
| 5 | `u`, `u3` | force unique results (`u3` gives up after 3 attempts) |
| 6 | `kh3`, `kl1` | keep the highest / lowest N |
| 7 | `dl1`, `dh1` | drop the lowest / highest N |
| 8 | `>=8` | a plain yes/no: each die reads success or failure |
| 8 | `s>=8` | mark the hits and say nothing about the rest |
| 8 | `f1`, `f<=1` | mark each qualifying die a failure |
| 9 | `cs>=19` | flag critical successes |
| 10 | `cf<=2` | flag critical failures |

Writing the `s` says what counts as a hit and nothing at all about the rest —
the alternative to a success need not be a failure — so `3d6s5` marks its hits
and leaves the other dice unmarked. A bare comparison is a plain yes/no, so
`3d6>=5` marks every die one way or the other.

Comparison points are `=`, `!=`, `<`, `>`, `<=`, `>=`. A bare number reads in whichever
direction the modifier naturally means: `e5` explodes on 5 **or more**, `r2` re-rolls 2
**and below**, `cs19` flags 19+, `cf2` and `f1` flag the low end, `u3` matches exactly 3.

The other side of an explicit comparison need not be a number. It can be anything that
works out to a single value — another roll, a word, a variable — and it is worked out
afresh for every comparison it takes part in, so `4d6>d4` rolls its own d4 four times.
A set there is refused before the roll.

```
4d6>d4                  each die against its own fresh d4
loot=gem                a word on the right
4d20>=atk               a variable on the right
```

### Bracket groups

Modifiers written after a closing bracket act on every die inside it, rather than on a
single term:

```
(3d6+2d8)kh3      keep the best 3 dice across the whole group
(4d6+2d10)dl2     drop the worst 2 overall
(2d6+3d8)>=5      count every die of 5 or more as a success
(2d20+2d12)kl1    keep the single worst die
```

Keep, drop and target success/failure are the modifiers that make sense here.

### Maths

`+ - * / % ^` (or `**`), parentheses, and `max` / `min` — the two functions that reduce
several values down to one. The scalar helpers (`floor`, `sqrt`, `abs`, …) are gone.

```
(1d6+2)*3        max(d20,10)        min(2d6,7)
```

### Words and choices

Alongside numbers there are **words**. A check produces one — `d6>4` reads as `success`
or `failure` — and you can write your own, bare when it is unambiguous or quoted when it
is not. Words carry no number, so a word can only ever be a result.

```
hit                     a bare word (characters a-z, A-Z and _)
"a long word"           quoted, so spaces are allowed
d20>=15 ? hit : miss    C-style choice; the condition must read success or failure
4d20>10 ? hit : miss    one choice per die, so four answers
```

The choice distributes exactly as the comparison does: one condition per member, one
answer per member. `4d20>10 ? hit : miss` is four separate choices, not one taken on
the sum, so it is the same as writing `d20>10?hit:miss` four times. Something carrying
no check at all is not a condition, and saying so is a pre-roll error.

Only the success check casts to a number — `success` is 1 and `failure` is 0, so
`3d6s5+1` works. The failure, critical-success and critical-failure checks are terminal:
using one in a calculation is rejected before the roll happens.

### Custom dice

Square brackets are a die whose faces you write out. One face is picked, then whatever is
on it is worked out — so a face can be a number, a word, or another roll. A number lands
on a die drawn with the shape matching the face count; a word is simply written out, since
a shape behind a word only hides it.

```
[1,1,1,1,1,6]           six faces, mostly ones — drawn as a d6
[hit,hit,miss]          faces can be words
[d6,d10]                a face can be another roll
3[a,b]                  roll a custom die three times, into a set
```

### Variables

A variable holds an expression and is worked out **afresh at every occurrence**, so `2atk`
really is two separate rolls. Set them in the **Vars** panel. A bare word becomes a
variable when one of that name exists, and stays a word otherwise; `{name}` insists on the
variable and errors when it is missing.

```
atk = d20+5             set in the Vars panel
2atk>13                 the same as atk>13, atk>13
{atk}                   never mistaken for the word "atk"
```

A variable holding a plain integer gets a −/+ pair in the panel for nudging it
between rolls.

`:=` sets one inside the expression itself, for that expression alone. It has to
stand as its own top-level item, and it shadows a panel variable of the same
name:

```
atk:=d20+5, 2atk        the same as 2(d20+5)
x:=2d6, y:=x+1, y       assignments can build on each other
```

A variable that refers back to itself is caught at a fixed depth rather than hanging.

### Whole-roll extras

```
6x 4d6dl1               roll the entire expression 6 times and report each set
2d6, 3d8, d20           comma: separate rolls, reported as one entry
2d20kh1+5 # attack      everything after # is a label, ignored by the maths
```

## Interface

* **Expression** — live syntax highlighting. Errors underline the field and the status
  line names the position.
* **Preview** — above the expression, the dice it *would* throw, drawn from the parse
  alone and carrying their die name rather than a face, since nothing has been rolled.
  Variables are opened up, so `2atk` shows the d20 it stands for, with the variable's name
  on the bracket underneath. Comparisons are written out, since they are what the roll is
  being read for. It updates as you type and never involves randomness, and it holds room
  for two rows of brackets so ordinary typing never jolts the page.
* **Result** — nothing rolls until you ask: <kbd>Enter</kbd> or the Roll button. Each roll
  lands in the log collapsed; click it to open. Dropped dice are struck out, exploded dice
  are amber, re-rolled dice show their original value, successes and criticals are
  colour-coded. Both travel down from wherever they were decided: discard a whole group
  and every die under it is struck, check a group and every die under it is coloured, with
  the closest check always winning.

  The headline is a number, or — when the roll produces result types — a game score:
  every type the expression could possibly produce, best to worst, so a critical that
  never turned up still shows its nought. A roll that lands on a word shows the word.

  A choice shows only the branch it took, joined to the comparison that caused it by
  **so** — `18 ≥ 15 so hit`, `7 < 15 so miss`. The statement written out is always the one
  that held, so a check that missed shows the opposite comparison rather than a false one.
  The preview above the field, where neither branch has happened yet, spells both out
  with **if / then / else** instead.

  Dice within a term are joined by the `+` they stand for, and every subtotal is drawn as
  a bracket in a tree beneath them, innermost nearest the dice — so `((2d6+d6)*d6)+8d10`
  shows what each bracket came to on the way to the total. Every modifier gets a bracket
  of its own rather than a number, in the order it was applied, so `10d6kh8kl5` reads
  `kept 8 highest` then `kept 5 lowest`. The verb and the count come first: a bracket too
  narrow for the whole phrase keeps its front, and `kept 5` says more than `lowest` does.
  A variable rides along on its bracket as a name, written before the value so you know
  what the number is before you read it; a short name always shows in full even where the
  bracket is narrower, and a long one gives up letters rather than disappearing. A subtotal
  that holds words shows the words rather than a meaningless sum, and a term whose value
  fills the whole row has no bracket at all, since the headline already says it.

  Brackets in the result mark where something reaches, so they are only drawn where there
  is a reach to mark: a variable standing for one value is written bare.

  Past three dice a term overlaps its own dice so it never takes more room than three;
  the individual faces stop mattering there and the subtotal speaks for the term.

  Each card carries a **roll again** button, and clicking an opened entry anywhere inert
  folds it back up. Collapsed entries show their dice, and their label if they have one,
  otherwise the expression — never both.

  Each die is a 3D render of a real solid, drawn from one inline SVG sprite referenced
  with `<use>`, so the shapes cost no extra requests and recolour from CSS:

  | Sides | Solid |
  |---|---|
  | 4, 6, 8, 12, 20 | the Platonic solids |
  | 10 | pentagonal trapezohedron |
  | 2 | coin |
  | 100 | zocchihedron |
  | 5, 7, 9, 11 | n-gon barrels, long enough that they cannot land on an end |
  | 14, 16, 18 | n/2-gon bipyramids |
  | 3 | borrows the cube |
  | 1, 13, 15, 17, 19 | borrow the d20 |
  | anything above 20 | borrows the d100 |


  Dice shrink as the count grows — 34px, then 26px past 18 dice, then 19px past 60 — and
  past 240 dice they fall back to plain text chips so typing never stalls. Those
  thresholds live in `DENSITY` at the top of `app.js`.
* **Explain** — one row per token. Click a row to select that token in the field; moving
  the caret highlights the matching row. Hovering any piece — a die, an operator, either
  half of a bracket pair, or a subtotal — lights up its counterparts everywhere. Node ids
  only mean something within one expression, so hovering is scoped: identical expressions
  share a scope and link to each other, while unrelated history entries stay put. What a
  variable rolls is deliberately left untagged — those dice have no place in the expression
  being edited — so hovering one lights the variable as a whole instead.
* **Details** — Monte-Carlo distribution of the total (min / mean / median / max / std dev
  / percentiles) with a histogram. Sample size adapts to keep it responsive.
* **Reference** — a gallery of every die that has a solid of its own, plus the full cheat
  sheet. From 1000px up it sits in a permanent rail on the left; below that it folds back
  into the drawer as a tab. That breakpoint is the single `wide` media query in `app.js`.

  Every entry is a complete, valid expression with the part that does the work picked out
  in colour and the scaffolding greyed — `4d6`**`kh3`**. Clicking applies only the coloured
  part, to the innermost dice term or bracket the caret is in, so `2d6+3d8` with the caret
  in the first term becomes `2d6ri+3d8` rather than gaining a stray fragment.

  A click can never leave the field unparseable. Each form builds candidates in order of
  preference — attach directly, bracket the target first, append as a separate roll — and
  the first one that parses wins. An empty field gets the whole example, since there is
  nothing to attach to. If nothing fits, the click is refused.
* **Vars** — the named expressions. Each row parses as you type and says what is wrong
  underneath; an integer gets a −/+ pair. Remove sits ahead of the name, where it is an
  easy target, and only the two fields take <kbd>Tab</kbd>.
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
viewed through **one shared camera**. Back faces are culled and the rest shaded with a
Lambert term. The result is baked into the SVG sprite; there is no 3D at runtime, just
static paths.

Only two things differ between shapes: **which face rests on the ground**, and the
**yaw** it is turned to. The camera's pitch, position and scale are constants — the
projection never looks at the shape.

Yaw comes from the resting face, the same rule everywhere: take the edge of that face
lying furthest from the solid's own axis, point it at the camera, then turn off square by
`YAW` to open up the side faces. Measuring against the solid's axis is what keeps the
families agreeing — barrels present their long side, bipyramids and the trapezohedron
their equatorial edge — while on the Platonic solids the resting face is regular, so
every edge is equivalent and the choice is free.

The d4 adds a further 60°, putting a base corner toward the camera so all three ground
vertices sit along the bottom with the apex clear above them.

Every solid is normalised to a circumradius of 1, so apparent size falls out of the
geometry itself rather than a per-shape fit; a die that is genuinely squatter renders
smaller. To resize one deliberately, give it a `size` in the shape list, which scales the
solid in 3D before the camera ever sees it.

The value is drawn centred on the die at one constant size, the same for every shape and
every value, so the generator emits no per-shape CSS.

Faces are painted with `currentColor` at a baked opacity over an opaque body, which is
why one CSS colour still drives every roll state. The generator also emits each shape's
`--nx` / `--ny` / `--nsz`, positioning the value on the face aimed at the camera.

Do not hand-edit the sprite or the generated CSS block. Change the generator and run:

```bash
node tools/splice.js
```

`engine.js` exposes `window.DiceEngine`:

```js
DiceEngine.roll('4d6dl1')      // → { total, numeric, text, marks, possible, sets: [...] }
DiceEngine.inspect('4d6dl1')   // → { spans, rows, notation }  (highlight + explain)
DiceEngine.analyse('4d6dl1')   // → { min, max, mean, median, stdev, p10, p90, totals }
DiceEngine.parse('4d6dl1')     // → { ast, repeat, label, ... }
```

Randomness comes from `crypto.getRandomValues`, falling back to `Math.random`.
Guard rails: 5,000 dice per term, 20,000 per expression, 500 chained explosions or
re-rolls per die.
