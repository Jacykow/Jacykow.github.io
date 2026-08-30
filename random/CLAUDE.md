# Random Engine — notes for whoever works on this next

A dice-notation console: type an expression, it is highlighted and explained as
you type, and rolled only when you ask. No build step, no dependencies, no
network. `README.md` is the user-facing documentation — read it first, it is the
spec. This file is the parts that are not obvious from the outside.

```bash
node serve.js          # http://localhost:5173
node tools/splice.js   # regenerate the dice art into index.html + style.css
```

## The files

| File | What lives there |
|---|---|
| `engine.js` | tokenizer, parser, evaluator, explainer, preview. **No DOM.** Exposes `window.DiceEngine`. |
| `app.js` | everything DOM: highlighting, caret sync, result log, subtotal trees, tools, storage. |
| `index.html`, `style.css` | markup and theme. Both contain a **generated** dice-art block. |
| `tools/gen-dice.js`, `tools/splice.js` | the generator behind that block. |
| `serve.js` | 25-line static server. |

Never hand-edit the `<svg id="dice-sprite">` in `index.html` or the generated CSS
block. Change `tools/gen-dice.js` and run `tools/splice.js`.

## The ideas everything else rests on

**Two structural types: value and set.** A set becomes a value by being summed,
and that is the *only* implicit reduction. `,` is the set constructor —
whitespace never is, so `d10-2d6` and `d10 -2d6` are the same thing. Brackets
only group: `(3d6+2d8)` is a value and `(3d6,2d8)` is a set, which is why `kh`
attaches to the second and errors on the first.

**Modifiers declare the type they need** (`MODS`), so every mismatch is a
`DiceError` thrown by `typeCheck` *before* anything is rolled. A green tick in
the status line that fails on Enter is a bug; if you add a construct that can
fail at roll time, add the static check with it.

**Element modifiers distribute, and so does `?:`.** `4d20>5?hit:miss` is four
comparisons and four choices, never one taken on the sum. Anything that reads a
condition should follow that shape.

**A comparison's right-hand side takes a plain integer where there is one and a
`primary()` otherwise**, so `3d6>=5+1` stays `(3d6>=5)+1`. It is evaluated once
per comparison, which is what makes `4d6>d4` roll four separate d4s.

**Values share one prototype** (`VALUE`, built by `value()`). Two methods that
look redundant are not: `total()` is what a value counts as and may throw —
a terminal result type has no number — while `raw()` is the number underneath
and never consults the check. The display always uses `raw()` via `safeTotal`,
which is what keeps a non-castable check drawable.

**State travels down `html(o)`, not up.** A discard or a check high in the tree
reaches the dice under it through the options object, closest check winning
(`ctxFor` / `inheritClass` / `isDropped`). This is why `Expr` keeps its parts
instead of a baked HTML string — bake it and nothing can reach inside afterwards.

**Advantage is the one modifier that re-rolls rather than reshapes.** `a` / `da`
roll the whole term again and keep the best or worst *total*, so they hook the
top of `evalNode` instead of joining `applyMods`, and have to be written last —
anything after them would apply to each attempt rather than to the winner.
`da` must be tested before the `d` that starts `dh`/`dl`/drop, which would
otherwise match its first letter and abandon the whole modifier.

**The label names things.** A saved roll and a variable are each just an
expression whose `# name` says what it is called; nothing stores a name beside
one. That is what lets a single field hold the whole thing, and why nothing can
drift out of step. `varAst` strips the label before parsing, so a variable's
name is drawn once — on its subtotal bracket — and never twice. A `{name}` in
the label is the identifier expressions use when that differs from the title;
`<dN>` in a title draws the die (`nameOf` / `titleOf` / `titleHTML`).

**Details splits a roll into its repeated pieces** (`unitOf`) and summarises each,
then the total — but only where the pieces are independent, since keep, drop and
advantage couple them. What the total can be is every way of choosing one from
each piece, which multiplies out fast, so past `LIMIT.combos` it falls back to
what the run turned up.

**Details says what could happen, not only what did.** `outcomes()` reads the
tree rather than the run: `wordsOf` lists every word the result could be, in
source order, and `boundsOf` is interval arithmetic giving the smallest and
largest number reachable. `null` means it cannot be said — an exploding die has
no ceiling worth quoting — and the chart falls back to what was observed.

**A chain of comparisons works its subject out once.** `d6>4?yes:>2?maybe:no`
parses as a `band`, not nested ternaries, by lifting the first comparison back
off the condition to leave the thing every arm is about. Nesting ternaries would
re-roll, which is the whole reason the construct exists.

**Variables hold source text**, re-parsed and re-rolled at every occurrence, so
`2atk` really is two rolls. Their nodes are deliberately left untagged
(`ctx.mute`): they have no span in the expression being edited, so linking them
there would be a lie. Hovering one lights the variable as a whole instead.
`::=` is the opposite — rolled once into `ctx.fixed`, with later mentions
rendered as a `Ref` that holds no `inner`, so its dice are counted once.

## Things that are easy to break

- **Node ids are the wiring.** Every piece of the editor, Explain, preview and
  result carries the same `data-x`, and `data-scope` keeps ids from meaning
  anything outside their own expression. Emit both or nothing.
- **The editor is a transparent `<textarea>` over a `<pre>`.** Their font,
  padding and line height must match exactly or the caret drifts.
- **Cutting the source up happens before the parser sees it** (`splitParts`,
  `labelAt`), so those two have to know about brackets and quotes independently.
- **Two kinds of link, for two jobs.** The address bar holds the expression and
  nothing else, written on a roll — never on a keystroke, because Safari
  rate-limits `replaceState` to about a hundred calls per half minute. A setup
  link (`#setup=`) carries the saved rolls and variables; it is adopted whole,
  and what it replaced is stashed so it can be had back.
- **Everything that writes into the field goes through `typeInto`**, which uses
  `execCommand('insertText')` so the browser keeps its own undo history.
  Assigning `.value` wipes it, and then Ctrl+Z does nothing.
- **Vars and Saved are one list rendered twice** (`LISTS`, `renderList`). They
  differ only in where they are stored and what clicking the name does.
- **Reference clicks must never leave the field unparseable.** `applySnippet`
  builds candidates in preference order and takes the first that parses;
  refusing the click is an acceptable outcome.
- **The shortcut bar and the Vars panel are two views of one list.** Whichever
  is being typed into does not get rebuilt — the other does. Stepping a number
  never rebuilds the bar either, or the button would move out from under the
  cursor as the number gains a digit.
- **The subtotal tree is an overlay, not a strip underneath.** Bars are placed
  from `getClientRects()`, one per line a node runs onto, so it survives content
  that wraps — which it does on a desktop, where the expression and its preview
  wrap rather than scroll. Room comes from the line-height, set to fit the
  deepest stack. A bracket over a single value (`data-lone`) becomes a line from
  its name to it when the name will not fit inside.
- **Subtotal rows are assigned deepest-first.** An enclosing bracket sits above
  everything it encloses, so it has to be settled after the things inside it
  have finished rising, or two brackets land on the same row.
- **Subtotal brackets:** a modifier draws its own bracket with no number
  (`data-steps`), a name rides along with the number (`data-note`), and a node
  filling its whole row draws nothing because the headline already says it.
  Labels crop from the end, so the verb and count survive.
- **The dice art uses one shared camera.** Only the resting face and the yaw
  differ per shape; pitch, position and scale are constants, and size comes from
  the shape's own circumradius.

## Testing

There is no test runner. `engine.js` is pure and loads under Node with two stubs,
which is enough for a throwaway harness:

```js
global.window = {}; global.crypto = require('crypto').webcrypto;
new Function(require('fs').readFileSync('engine.js', 'utf8'))();
const E = window.DiceEngine;
```

Worth doing on any change to the engine: run a list of expressions through
`roll` + `html` + `inspect` + `preview` and re-`roll` the returned `notation` to
check it round-trips; check a few means against their analytic values
(`4d6dl1` ≈ 12.24, `2d20kh1` ≈ 13.83); and fuzz. A `DiceError` is a fine answer
to nonsense — anything else, or a non-finite total, is a bug in the engine.

## Shipping

Live at <https://www.gulij.com/random>, served from the `Jacykow/Jacykow.github.io`
repo (a GitHub Pages user site, no build step). Work happens here; the deploy
copy is `../Jacykow.github.io/random/` on branch `random-engine`, kept as a plain
copy of this directory.

Branch and commit freely. **Never push and never merge to `main`** — Jacek
reviews `git diff main..random-engine` and does both himself.
