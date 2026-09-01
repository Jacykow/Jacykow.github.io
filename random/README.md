# Random Engine

A lightweight, dependency-free web console for advanced dice notation — with the UX of
[regexr.com](https://regexr.com): you type an expression, it is syntax-highlighted live,
broken down token-by-token in an **Explain** panel that stays linked to your caret, and
previewed as the dice it would throw.

No build step, no dependencies, no network calls. Six files of source and nothing else.
Designed for phones as much as desktop.

**Live: <https://www.gulij.com/random>**

```bash
node ../serve.js
```

Then open <http://localhost:5173/random/>. (Opening `index.html` directly via `file://`
also works.) The server sits a directory up because this is one part of a larger site.

---

## Contents

* [Where the notation comes from](#where-the-notation-comes-from)
* [Syntax](#syntax)
  * [Dice](#dice)
  * [Values and sets](#values-and-sets)
  * [Modifiers](#modifiers)
  * [Maths](#maths)
  * [Advantage](#advantage)
  * [Bracket groups](#bracket-groups)
  * [Words and choices](#words-and-choices)
  * [Custom dice](#custom-dice)
  * [Variables](#variables)
  * [Whole-roll extras](#whole-roll-extras)
  * [Categories](#categories)
* [Interface](#interface)
  * [What a colour means](#what-a-colour-means)
  * [Two kinds of link](#two-kinds-of-link)
* [Files](#files)
  * [The dice art](#the-dice-art)

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
| `3d(3*5)` | computed number of sides |

### Values and sets

There are two structural types, and one rule ties them together:

> **A term's value is its total.** A modifier is about that value unless it is marked
> `@`, which is about each member instead.

A set is built by a count (`4d6`), a list (`(d6,d8)`) or a repeat (`3(d6+1)`). Brackets do
not build one: `(2d6)` is still two dice.

```
2d6>=5           is the total 5 or more? one yes or no
2d6@>=5          is each die 5 or more? two verdicts, 0 to 2 successes

2d6e             roll 2d6 again and add, when the total is 12
2d6@e            roll a die again and add, for each die that shows 6

2d6min3          the total, floored at 3
2d6@min3         each die, floored at 3
```

The `@` goes in front of whichever modifier it is about, and only in front of the ones a
single member can answer for. Keeping, dropping and making unique are choices made
*between* members, and advantage throws the whole term again, so none of them takes one:

```
4d6dl1           drop the lowest of the four — about the set, so no @
4d6@kh1          refused: kh is about the set as a whole
2d6a             the better of two totals — about the term, so no @
```

A lone die is its own total, so the two readings agree and `d6e` needs no mark.

**Where the total is still what is meant**, because nothing else would make sense:

```
2d6+1            arithmetic reduces each side to a value
(2d6)d10         how many dice to roll
d(2d6)           how many sides a die has
2d6a             each attempt of advantage, compared by total
[2d6,99]         a face of a custom die is worth one number
```

**Where the members are what is meant:**

```
sum(2d6)         everything added up
max(2d6)         the largest member — min() the smallest
2d6@*2           each die doubled
4d6kh3           keep and drop choose between members
((2d6),(3d8))kh1 a bracket, as an item of a list, is one member
```

`sum`, `max` and `min` take the members of everything handed to them, flattened together,
so `max(2d6,7)` is the largest of three numbers.

**And one place a set is refused rather than reduced**: the right-hand side of a
comparison. `d6 = 2d6` is an error — write `sum(2d6)` for the total, or put the set on the
left to compare each die.

#### The two bindings differ in one thing only

`:=` is worked out afresh at every mention; `::=` is thrown once and then referred to.
Both hold whatever they were given, set or value, and behave identically in every other
respect:

```
x:=2d6, x@>=5, x@>=5      four dice, two pairs of verdicts
x::=2d6, x@>=5, x@>=5     two dice, asked about twice
x::=2d6, x>=7             one verdict, about the total
```

### Modifiers

Modifiers chain onto a dice term in any written order — they are always **applied** in the
fixed order below, so `4d6kh3@e` and `4d6@ekh3` mean the same thing. A term may only carry
one explode modifier.

Each of them is about the term's **total** unless it is written with `@` in front, which
makes it about each member: `4d6>=5` asks one question about the sum, `4d6@>=5` asks four.
See [Values and sets](#values-and-sets).

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
| 8 | `@*2`, `@^2`, `@-1` | arithmetic, to each member rather than to the total |
| 9 | `>=8` | a plain yes/no: each die reads success or failure |
| 9 | `s>=8` | mark the hits and say nothing about the rest |
| 9 | `f1`, `f<=1` | mark each qualifying die a failure |
| 9 | `cs>=19` | flag critical successes |
| 9 | `cf<=2` | flag critical failures |
| 10 | `a`, `a3` | advantage: roll it all again and keep the best total |
| 10 | `da`, `da3` | disadvantage: keep the worst |

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

### Maths

`+ - * / % ^` (or `**`), parentheses, and three functions that reduce several values to
one: `sum`, `max` and `min`. The scalar helpers (`floor`, `sqrt`, `abs`, …) are gone.

```
(1d6+2)*3        max(d20,10)        min(2d6,7)        sum(2d6)
```

A function call is a term like any other, so a modifier hangs off it:
`max(d20,10)>=15`.

Division is **whole-number**, truncated toward zero, because dice are: `7/2` is 3 and
`-7/2` is −3. With `%` that reads the digits off a roll, and `(a/b)*b + a%b` still comes
back to `a`.

```
d100/10          the tens digit of a percentile roll (0–10)
d100%10          the units digit (0–9)
roll::=d100, roll/10, roll%10      both, off one die
```

Unless you ask otherwise, and a written `.` is how you ask. Nobody types a decimal point
by accident, so a number that has one makes the arithmetic it takes part in real:

```
7/2              3      three whole shares
7/2.0            3.5    a half is wanted, and a half is written
5d20dhdl/3.0     the middle three d20s, averaged
```

The `.` is what carries: `3.0` and `3` are the same number and not the same thing to
divide by. Nothing else makes a fraction on its own — no die, no modifier, no average —
so an expression without a decimal point in it answers in whole numbers as it always did.
A result is shown to the hundredth; what you wrote is kept exactly as you wrote it.

#### Doing it to each member

Arithmetic reduces a set to a value first: `2d6*2` doubles the **total**. `@` is the way
round that — it applies one operator to **each member on its own** and hands back a set
of the same size.

```
2d6@*2           each die doubled, then summed: 2..24
2d6*2            the sum doubled: 4..24
(3d6,2d8)@^2     every member squared
4d6kh2@*10       the two kept dice, each ×10
```

One operator and one operand at a time, so the reading is never in doubt: `2d6@*2+3`
doubles each die and then adds 3 **once**. Chain another `@` to do both to each.

```
2d6@*2@+3        each die doubled and then given +3
2d6@*d4          a fresh d4 for every die, as a comparison would roll one
```

It runs after keep and drop and before a check, so `2d6@*2>=8` compares the doubled
values, and a member already thrown away is left alone.

### Advantage

`a` rolls everything to its left a second time and keeps the better result; `da`
keeps the worse. A number says how many attempts to make. Each attempt is summed
before they are compared, so this is the best **total**, not the best single die
— `2d6a` is the better of two 2d6 sums, while `2d6kh1` is the higher of two dice.

```
2d6a            the better of two 2d6 totals
2d6da           the worse
d20a            the familiar one
2d6a3           best of three
4d6dl1a         everything else happens first, then the better of two
```

Because it re-rolls everything before it, `a` has to be the last modifier on a
term. Bracket it to carry on: `(2d6a)>=9` compares the winning total, where
`2d6a>=9` would have compared each attempt.

### Bracket groups

A modifier written after a closing bracket acts on everything the bracket holds — as long
as the bracket holds a set. **The comma is what makes one.** `+` sums, and a sum is a
single value with no members left to keep, drop or count:

```
(3d6,2d8)kh3      keep the best 3 dice across the whole group
(4d6,2d10)dl2     drop the worst 2 overall
(2d6,3d8)>=5      count every die of 5 or more as a success — 0 to 5 of them
(2d20,2d12)kl1    keep the single worst die
```

With `+` in place of the comma, `(3d6+2d8)kh3` is refused: there is one value there, not
five dice. `(2d6+3d8)>=5` is not refused, and that is worse — it is one comparison
against the total, which is never below 5, so it is always exactly one success.

Keep, drop and target success/failure are the modifiers that make sense here.

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

An else that opens with a comparison carries on about the same thing, which sorts one
roll into as many outcomes as you like:

```
d6>4 ? yes : >2 ? maybe : no
(2d6+3)>=13 ? crit : >=10 ? good : >=7 ? mixed : bad
```

The subject is worked out **once** and each comparison is tried against it in the order
written; the first that holds gives the answer. Since a comparison binds to a term
rather than a sum, bracket what the chain is about — `2d6+3>=13` compares the 3.

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
really is two separate rolls. Set them in the **Variables** panel. A bare word becomes a
variable when one of that name exists, and stays a word otherwise; `{name}` insists on the
variable and errors when it is missing.

A variable is named by the `# name` at the end of its own expression, so `0 # modifier`
is a variable called `modifier` holding `0`. Saved rolls are named the same way, and
saving refuses an expression that has no name.

What a thing is called and what it is written as are two questions. A `{name}` inside the
label answers the second when they differ, and is not shown:

```
0 # Modyfikatory {mod}      shows as Modyfikatory, written as mod
2d6 # 2x <d6>               <dN> draws the die instead of spelling it
```

`<dN>` works in any label, not only a name — `2d6 # Rzut <d6><d6>` labels the roll with
two dice wherever that label is shown.

```
d20+5 # atk             a variable, set in the Variables panel
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

`::=` is the opposite: **rolled once**, however often it is named. Every mention after
the first shows the name and what it came to rather than drawing the same dice again.

```
roll::=d6, roll, roll   one die, named twice
roll:=d6, roll, roll    two dice, since the name is worked out again
roll::=2d6+3, roll>=10 ? good : >=7 ? mixed : bad
```

A `::=` binding stands for what its roll came to, so it is a value and never a set.

What a checked pool **counts as** is its hits, so binding one and then comparing the name
asks how many there were rather than what the dice showed. That is how a roll gets read
twice, or read and then counted:

```
h::=4d6=6, h>=2?"crit":"no"                     two or more sixes
h::=8d6>=5, g::=8d6=1, (g*2)>8?"glitch":h>0?"hit":"miss"
n::=d20, (n=20)?"crit":(n+mod)>=dc?"hit":"miss"  the natural face beside the total
```

Written without the binding, `(4d6=6)>=2` means something else: brackets only group, so
that is still a set and the comparison distributes over it, four dice compared against 2.

A binding is in scope for everything else in the expression, variables included, so a
variable can read one like an argument:

```
tens := roll/10                 set in the Variables panel
units := roll%10
roll::=d100, tens, units        the variables read the roll bound here
```

A variable that refers back to itself is caught at a fixed depth rather than hanging.

### Whole-roll extras

```
6x 4d6dl1               roll the entire expression 6 times and report each set
(d4)x 4d6dl1            roll it as many times as a d4 says, thrown afresh
2d6, 3d8, d20           comma: separate rolls, reported as one entry
2d20kh1+5 # attack      everything after # is a label, ignored by the maths
```

### Categories

Saved rolls and variables are grouped under headings shared by both lists. A heading says
where something is shown and nothing about what it means: a variable under one is still
written the same way from anywhere, and a name is a name everywhere.

Drag a row by its name to reorder it or to put it under another heading; drag a heading by
its grip to move the whole group. A new item starts under no heading, in the loose group at
the end. Under the expression the groups can be folded away one at a time — that is the
one place they fold, since the drawer is where you go to see all of them at once.

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
  never turned up still shows its nought. A roll that lands on a word shows the word, and
  one that lands on several shows them as a score too: one figure per word the expression
  could say, in the order it says them.

  A headline is one figure and a set is not one thing, so an opened card also reads the
  members one at a time, wherever they say more than the dice under them already do.
  `10d2@=1?1:3` is ten dice showing 1 or 2 and a result of `1, 3, 1, 3, …`; a set of
  words shows the words as they fell, and under them the score with its words named,
  `6 heads - 4 tails`.

  A choice shows only the branch it took, joined to the comparison that caused it by
  **so** — `18 ≥ 15 so hit`, `7 < 15 so miss`. The statement written out is always the one
  that held, so a check that missed shows the opposite comparison rather than a false one.
  The preview above the field, where neither branch has happened yet, spells both out
  with **if / then / else** instead.

  Dice within a term are joined by the `+` they stand for, and every subtotal is drawn as
  a bracket in a tree beneath them, innermost nearest the dice — so `((2d6+d6)*d6)+8d10`
  shows what each bracket came to on the way to the total. Every modifier gets a bracket
  of its own rather than a number, in the order it was applied, so `10d6kh8kl5` reads
  `keep 8 highest` then `keep 5 lowest`. A step names what the modifier does rather than
  narrating what became of the dice — it hangs under a roll that has plainly happened, so
  a tense buys nothing and costs the letters that make it fit. It reads the same in the
  preview, in the result and on a phone. The verb and the count come first: a bracket too
  narrow for the whole phrase keeps its front, and `keep 5` says more than `lowest` does.
  A variable rides along on its bracket as a name, written before the value so you know
  what the number is before you read it; a short name always shows in full even where the
  bracket is narrower, and a long one gives up letters rather than disappearing. A subtotal
  that holds words shows the words rather than a meaningless sum, and a term whose value
  fills the whole row has no bracket at all, since the headline already says it.

  Brackets in the result mark where something reaches, so they are only drawn where there
  is a reach to mark: a variable standing for one value is written bare. A bracket hangs
  from the bottom of what is on the line rather than from the line's own text, so it sits
  under the dice it is about and not over them, and the room for a stack of them is taken
  under the last line rather than out of the space between every pair of lines.

  Past three dice a term overlaps its own dice so it never takes more room than three;
  the individual faces stop mattering there and the subtotal speaks for the term.

  An opened card writes the expression in the colours the editor gives it, since a colour
  means one thing everywhere.

  Each card carries **roll again**, which throws that expression again and leaves the
  field alone, and **edit**, which puts it back in the field and throws nothing — two
  wants that one button cannot serve, since having the first would cost you whatever you
  were editing. Clicking an opened entry anywhere inert folds it back up. A collapsed entry is four columns — what you called it, what it came
  to, what it was thrown with, and when — in the order they matter when you are looking
  back down a log. The name is the label if there is one and the expression if there is
  not, never both, and it holds a column of its own so the results line up under each
  other. The dice are only the dice: ten coins read as ten faces, and the reasoning that
  turned them into words is the opened card's business.

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
* **Explain** — one row per token, indented to the depth it sits at, so a bracket's
  contents read as its contents. Click a row to select that token in the field; moving
  the caret highlights the matching row. Hovering any piece — a die, an operator, either
  half of a bracket pair, or a subtotal — lights up its counterparts everywhere. A step
  bracket is a modifier's own, so pointing at `drop highest` lights the `dh` that asked
  for it and that bracket alone, rather than the term it happens to hang under. Node ids
  only mean something within one expression, so hovering is scoped: identical expressions
  share a scope and link to each other, while unrelated history entries stay put. What a
  variable rolls is deliberately left untagged — those dice have no place in the expression
  being edited — so hovering one lights the variable as a whole instead.
* **Details** — what the expression can come to. Where the shape of the expression allows
  it the answer is **worked out exactly** rather than watched for, and the run is drawn
  over the top as a second opinion; where it does not, the run is all there is. The line
  under the chart says which you are looking at, how many rolls stand behind it, and how
  many of them are yours.

  A roll that makes several kinds of value is broken into the smallest repeated piece and
  each is charted in turn, then the total: `3d10` reports the d10 and then the sum. It
  only splits where the pieces are independent — keep, drop and advantage couple them —
  and a choice is several pieces only when it is marked `@`, since a choice about a total
  is one question however many dice the total is made of.
  Words get a bar each, including the ones that never turned up, and every roll of this
  expression still in the log is marked beside the word it landed on, the most recent
  picked out. A set of words is two questions — what one member is likely to say, and what
  the set is likely to come to once they all have — so both are answered, the member first
  and then the set. The set is counted rather than ordered: ten coins land in a thousand
  orders and in eleven scores, and the score is what anybody reads. Two words make a line,
  `0 heads - 6 tails` through to `6 heads - 0 tails`, and are read along it; more than
  two have no such line, so there the commonest comes first.

  Numbers get one bar per value while they will fit, and past that one bar per run of
  whole numbers, inclusive at both ends. The first bar starts at the smallest the
  expression can reach and the last ends at the largest, so the axis never offers a value
  that cannot happen, and each bar is named under its own middle. Everything else is on
  the chart itself: the middle half and the tenth-to-ninetieth as bands behind the bars,
  the median and the mean as lines across them, and every roll of this expression still
  in the log as a tick along the bottom with the most recent picked out — a roll lands
  there as you make it.

  The chart answers questions rather than only showing a shape. Point at a bar and it
  says how often that value comes up, how often less, and how often more, lighting the
  bars each figure is counted from. Point at one of the figures underneath — the median,
  a percentile — and it lights the bars that figure is about and says what it means.

  The run fills in bursts — a short stretch of throwing, a redraw, a gap long enough for
  the page to stay answerable — until there are twenty thousand or a second has gone.
  Nothing is thrown while you type.
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
* **Shortcuts** — the star beside a saved roll or a variable puts it on a bar under the
  expression, so a session's handful of things stays in reach without opening the drawer.
  A roll shortcut rolls it; a variable shortcut edits the value and never the
  name, since the name is what expressions refer to. A whole number gets a −/+ pair,
  which move by one, or by ten with shift or the right mouse button. The bar is cut into
  the categories the items sit under, and each category folds away by its heading — this
  is the one place they fold, since the drawer is where you go to see them all at once.
* **Variables** and **Rolls** — the same list twice over, since a variable and a saved
  roll are the same thing: an expression named by its own `# name`. Each row is remove,
  bookmark, the name it is called by, what it says, and a −/+ pair when that is a whole
  number. Clicking the name puts a variable
  into the expression, or replaces the expression with a saved roll — and <kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back, as it does for anything
  else that writes into the field. <kbd>Ctrl</kbd>+<kbd>S</kbd> saves what you are
  editing, under its `# name` — or under `roll 1`, then `roll 2`, when it has none, since
  a missing name is a thing to supply rather than a reason to refuse. Saving opens this
  list at the row it just made and marks it for a moment, which says what "saved" would
  have said and shows where it went.

  Both lists are grouped under the same categories, so adding one in either adds it to
  both, and renaming one renames it in both. Each heading says how much it holds, counted
  across both lists. A row is dragged by its name to reorder it or
  to move it under another heading; a heading is dragged by its grip, and what is in it
  comes along. A new item starts under no heading, in the loose group at the end, which is
  also where something is dragged back out to. Removing a heading leaves what was under it
  loose rather than deleting it.
* **undo / redo** sit under the expression, for a screen with no keyboard to reach them
  from.
* **Preset** — your saved rolls and variables together. They live in this browser's
  `localStorage` between visits, like the rest; a preset link is only a way of moving them
  to another browser. **export** and **import** open their boxes when asked and stay shut
  otherwise. Opening a link loads it straight away. Pasting one into the panel
  instead offers what it holds first, marking each entry **new**, **update** or **same**,
  with everything but the sames selected; what you take is added to what you already have,
  or replaces the lot outright, and one button offers the same list back to undo it. Ready-made
  presets for a dozen games sit at the bottom — the first of them is what a browser with
  nothing stored starts from.

### What a colour means

A colour means one thing, wherever it appears: the editor, the preview, a result, the
reference and the Explain list all draw the same token the same way.

| | | |
|---|---|---|
| **value** | white | a number or a word, a die face, a total — including a number that is an operand, like the 3 in `d6>3` or `3[a,b]` |
| **name** | amber | a variable, a die, a binding, `max` and `min` |
| **label** | sage | the `# name` a roll is given, and the titles it becomes |
| **modifier** | blue | `kh3`, `e`, `>=5`, `@*2`, `6x` — and a die a modifier reached |
| **joinery** | grey | brackets, commas, operators, `?` and `:` |
| **inert** | fainter grey | times, hints, and scaffolding shown for context |
| **success** | green | only ever a verdict |
| **failure** | red | only ever a verdict |

A number and a word are the same kind of thing — a value — so they take the same colour;
what tells them apart is that only one of them can be added up. A die is a name in the
same sense a variable is: it stands for a value rather than being one, which is why `d20`
and `mod` read alike.

A number that could have been written as an expression is an operand, and reads as the
value it is: the count in `4d6`, the `3` in `3[a,b]`, the threshold in `d6>3`. A digit
baked into a modifier’s spelling is part of that modifier’s name and is not — `kh3` and
`min2` are one token each.

A label is the one name the notation never reads: it is what you called the roll rather
than something standing for a value, so it is the one name that is not amber. Its sage is
deliberately cooler and quieter than the verdict green, which is never a colour you can
write.

Green and red at full strength are spent entirely on verdicts, and a verdict always beats the role colour
of whatever carries it, so the same `"Miss"` is white where it is only a word and red
where a check made it one. A bare word is drawn as a name exactly when a variable of that
name is set, and as a value when it is not — the colour answers the question the word
itself leaves open.

In the reference the emphasis is carried by **fading the scaffolding**, not by recolouring
the working part — recolouring would tell a second story on top of the first.

### Two kinds of link

They are for two different things:

* **An expression link** is what the address bar holds — just the roll, plainly readable
  (`#2d20kh1+5`), updated when you roll. Copy it out of the browser and send it to
  someone. **Copy link** in the top bar puts it on the clipboard.
* **A setup link** carries every saved roll and variable, and the categories they sit
  under. Opening one adds what it holds to what you already have; pasting one into the
  Preset tab lists it first and waits to be told. Either way what it added is
  remembered, and one button takes it back out again.

A setup link comes in two forms, and they are read by the same code:

```
#setup=eyJuIjoyLCJjIjpbIkt…       a setup that exists nowhere else, spelled out
#preset=huberts-dream             a ready-made preset, named
```

The short form only needs the name because both ends already have the preset. Every
ready-made preset has one — **link** beside its name in the Preset tab copies it. The
first preset is the exception: it is what a browser with nothing stored already starts
from, so there is nobody to send it to, and its button is left off. `#preset=reset`
still works if you want it.

A link is adopted into what you already have. A browser that has nothing yet is the one
case where there is nothing to adopt it into: it would otherwise start from the first
preset and then take the link on top, leaving whatever the link happened not to contain
sitting in the bar beside it, looking like part of what was sent. So a link opened in a
browser that has never kept anything is the whole of what that browser gets.

Neither reaches the server — a fragment never leaves the browser — so length is only a
question of what a browser holds, which a setup of any sane size comes nowhere near.

A screen is only so tall, and the panes agree about who gives way when there is not enough
of it. The tools never do — a tab strip clipped off the bottom of a phone is nobody's
choice, and shutting the drawer is always at hand — so the bookmark bar holds as many rows
as are left once everything else has what it needs and scrolls to the rest, and the result
takes what remains after that. The expression itself gives nothing.

A tab is open or the drawer is shut, and there is no third state. Nothing is open when you
arrive: the tools are there when you go looking for them, and until then the results have
the room. Pressing the tab that is already open shuts it again, so the way back to a taller
result is the button you are already pointing at, and the chevron on the right does the
same for the tab you had last. One line under the tabs says what the open tab is for, and
the panes themselves carry no prose — a tab cannot arrive without its line. Layout uses
`dvh` units and safe-area insets, so browser chrome, the on-screen keyboard and notches
don't clip it.

## Files

| File | Purpose |
|---|---|
| `engine.js` | tokenizer, recursive-descent parser, evaluator, explainer. No DOM. |
| `app.js` | UI: highlighting, caret sync, result log, tools, storage. |
| `presets.js` | ready-made rolls per game, as data; each has the `id` its link names |
| `reference.js` | the reference panel, as data |
| `SYSTEMS.md` | what each game asks for, and what the notation cannot yet say |
| `index.html`, `style.css` | markup and theme |
| `tools/gen-dice.js` | builds the dice art (see below) |
| `tools/splice.js` | regenerates and writes it into `index.html` + `style.css` |
| `tools/check.js` | the engine's checks: `node tools/check.js` |

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
