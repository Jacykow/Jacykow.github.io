# Random Engine — notes for whoever works on this next

A dice-notation console: type an expression, it is highlighted and explained as
you type, and rolled only when you ask. No build step, no dependencies, no
network. `README.md` is the user-facing documentation — read it first, it is the
spec. This file is the parts that are not obvious from the outside.

This directory is one part of the site it lives in; `../CLAUDE.md` covers the
rest of it, including how any of it reaches the web.

Paths below are from the site root, where you probably are:

```bash
node serve.js                # the whole site; this is at /random/
node random/tools/check.js   # the engine’s checks; see Testing at the end
node random/tools/splice.js  # regenerate the dice art into index.html + style.css
```

## The files

| File | What lives there |
|---|---|
| `engine.js` | tokenizer, parser, evaluator, explainer, preview. **No DOM.** Exposes `window.DiceEngine`. |
| `app.js` | everything DOM: highlighting, caret sync, result log, subtotal trees, tools, storage. Data lives in `presets.js` and `reference.js`, not here. |
| `index.html`, `style.css` | markup and theme. Both contain a **generated** dice-art block. |
| `tools/gen-dice.js`, `tools/splice.js` | the generator behind that block. |
| `tools/check.js` | everything worth checking before committing an engine change. |
| `presets.js` | ready-made rolls per game, pure data. `PRESETS[0]` is what a fresh browser gets, and the one preset with no link button — there is nobody to send it to. |
| `reference.js` | the reference panel, pure data: example, description, form, hover note. |
| `SYSTEMS.md` | what each game's dice ask for, and which of them the notation cannot yet say. Read it before adding a preset. |

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

**`@` is the one modifier that hands back a different value than it was given.**
Every other one reshapes what a roll produced; `applyMap` builds new members, so
it is the only branch of `applyMods` whose result is assigned back. A set's
markup closes over the members array, which is why the rewritten members go into
that same array rather than into a new set.

**Numbers are whole where dice are.** `/` truncates toward zero (`idiv`), which
is what lets `d100/10` and `d100%10` read the two digits of a percentile roll and
keeps `(a/b)*b + a%b` equal to `a`. `arith` is the one place a `+`, a `@` or a
computed die size does the sum, so all three refuse an infinity the same way.

**Element modifiers distribute, and so does `?:`.** `4d20>5?hit:miss` is four
comparisons and four choices, never one taken on the sum. Anything that reads a
condition should follow that shape.

**A comparison's right-hand side takes a plain integer where there is one and a
`primary()` otherwise**, so `3d6>=5+1` stays `(3d6>=5)+1`. It is evaluated once
per comparison, which is what makes `4d6>d4` roll four separate d4s.

**Values share one prototype** (`VALUE`, built by `value()`). Three methods that
look redundant are not: `total()` is what a value counts as and may throw —
a terminal result type has no number — while `raw()` is the number underneath
and never consults the check. The display always uses `raw()` via `safeTotal`,
which is what keeps a non-castable check drawable. `base()` is the third: what a
comparison reads, which is `total()` so that a checked pool counts as its hits
(`h::=4d6=6, h>=2`), with the value's *own* check set aside so every arm of a
chain reads the same number instead of the verdict the arm before it wrote.

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

**Categories are headings, not namespaces.** A category says where something is
shown and nothing about what it means, so a variable under one is written the
same way from anywhere. One shared list (`LS_CATS`) serves both panes and the
shortcut bar; each item carries the name of the one it sits under, or none. That
is why an empty category still renders — it is a drop target — and why the loose
group at the end never disappears while any category exists.

**Details draws two answers at once.** `distribution()` works the answer out where the
shape of the expression allows it, and the sampler is laid over the top; a chart
that agrees with itself is the point of drawing both. `null` from the solver
means *cannot say* and travels all the way out — a partial answer would be
worse than none, since the chart would quietly stop being true. Three things
force it: a dependence the arithmetic cannot see (a `::=` binding, a choice
about the same roll), an unbounded support (an exploding die), and sheer size.

**A distribution is one number at a time, so it cannot see a set.** Everything
element-shaped — a check, a map, a clamp — acts on each member, so `withMods`
refuses outright on anything `isSet` says is a set. `(2d6)>=5` is two
comparisons, not one on the sum, and the solver has to say so by saying nothing.
Clamps are the odd one out even on a value: `min`/`max` only ever move a die
face, so once a value has been bracketed or named they do nothing at all —
which is what the engine does too.

**`study()` is the plan, not the answer.** It parses once and hands back a
sampler per section that can be filled in as slowly as the screen needs, so the
chart arrives in bursts instead of one stretch long enough to be felt. Nothing
is thrown while it is being built.

**A heading is part of what an item says.** Two items count as the same only when the
expression *and* the category match (`sameItem`). Comparing expressions alone
makes a preset that files a roll you already have under a name of its own look
like a duplicate, and half of what the preset is for never arrives.

**A preset's `id` is a promise.** It is what `#preset=<id>` names, so it is
written out in `presets.js` rather than derived from the name: renaming a preset
must not break a link somebody is already holding. Add one when you add a
preset; never change one that has shipped.

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
- **A colour means one thing.** Five roles and two verdicts, listed at the top
  of `style.css` and in the README. A number and a word are one role — a value —
  and a die is a name in the same sense a variable is. Green and red are spent
  entirely on verdicts. `describe` colours a bare word as a name only when a
  variable of that name is set, so it takes the variables to answer that. The
  reference and the Explain chips paint themselves with the editor's own `t-*`
  classes rather than a colour of their own; emphasis there is carried by
  fading, never by recolouring.
- **The chart is padded, so every overlay lives in `.layer`**, inset by exactly
  that padding. A band measured against the outer box lands a few pixels wide of
  the bars it describes — close enough to look like a rounding bug and waste an
  afternoon. `pctOf` puts a value in the middle of its own cell, which is why a
  mean of 3.5 lands on the line between 3 and 4 rather than inside one of them.
- **A phone raises its keyboard whenever the field takes focus**, so nothing
  refocuses it after a roll. On a narrow screen the expression pane's own title
  goes too, or the label of what is about to be rolled gets squeezed to nothing
  by the buttons beside it.
- **Every die value is one size**, however long. A D8 and a D10 side by side
  have to read as the same kind of thing, and a long one spilling over its shape
  beats one too small to read.
- **Where a row is kept and where it is drawn are two orders.** Rows are grouped
  under their headings, so `readList` and `commitList` read `data-i` off each row
  rather than counting them off the page.
- **`draggable` belongs on the handle, never on the row.** A `dragstart` names
  the draggable element itself, so a row that carried it could never say which
  part of itself the drag began on — a check for the handle there cancels every
  drag. The listeners hang off the pane, since every drop redraws the rows.
- **In the reference, what is coloured and what is inserted are two questions.**
  The `~` marks the part that does the work named in the description; an atom
  still inserts its whole example. Do not colour scaffolding to make an insert
  come out right.
- **Reference clicks must never leave the field unparseable.** `applySnippet`
  builds candidates in preference order and takes the first that parses;
  refusing the click is an acceptable outcome.
- **The shortcut bar and the Variables panel are two views of one list.** Whichever
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

There is no test framework and nothing to install. `engine.js` is pure and loads
under Node with one stub, which is all `tools/check.js` needs:

```bash
node random/tools/check.js        # about half a minute
node random/tools/check.js full   # ten times the samples, for a real change
```

The check that earns its keep is the first one it runs: wherever
`distribution()` claims an exact answer, the same expression is thrown a great
many times and the two are compared. Two independent answers agreeing is the
only evidence either is right, and it has caught every solver bug so far.

Because it makes hundreds of those comparisons, its thresholds are deliberately
loose — tight enough to catch a systematic error, loose enough not to cry wolf.
If one expression fails, throw it a million times by hand before believing it:
sampling noise looks exactly like a small bug.

The rest is what you would expect. Every preset expression and every reference
example must parse, roll, draw, explain, and survive being re-rolled from its
own printed notation. A handful of means are checked against their analytic
values. And nonsense is generated by the thousand: a `DiceError` is a fine
answer to it, but anything else, or a non-finite total, is a bug in the engine.

## Shipping

Live at <https://www.gulij.com/random>. What is in this directory is what is
served — there is no build step and no separate working copy, so editing a file
here changes the site. See `../CLAUDE.md` for the branch rules, which are the
one thing worth reading before committing anything.
