# Dice systems, and what the notation cannot yet say

The presets in `presets.js` cover the common shapes. This is the record of what
each system actually asks for, so the awkward ones can be taken one at a time
rather than rediscovered.

Everything in the first table has a preset. The rest is why the **Awkward rolls**
preset exists: each entry there is the closest the notation currently gets, and
this file says what the game really wants.

## What works

| System | Roll | Written as |
|---|---|---|
| D&D 5e | d20 vs a target, advantage, disadvantage | `d20+mod`, `2d20kh1+mod`, `2d20kl1+mod` |
| D&D 5e | ability scores | `4d6dl1`, `6x 4d6dl1` |
| Pathfinder 2e | four degrees, ten either side of the DC | `(d20+mod)>=(dc+10)?…:>=dc?…:>(dc-10)?…:…` |
| Pathfinder 2e | a natural 20 or 1 steps the degree | `n::=d20, base::=…, deg::=max(0,min(3,base+(n=20?1:n=1?-1:0)))` |
| Call of Cthulhu 7e | roll under, with degrees | `d100<=(skill/5)?…:<=(skill/2)?…:<=skill?…:…` |
| Call of Cthulhu 7e | the tens and units of a percentile | `roll::=d100, roll/10, roll%10` |
| Call of Cthulhu 7e | bonus / penalty die: a second tens digit, units shared | `u::=d10@-1, t::=(2d10@-1)kl1, v::=t*10+u, v=0?100:v` |
| World of Darkness | pool of d10s, 8 or better | `(pool)d10>=8` |
| World of Darkness | ten-again | `(pool)d10ei>=8` |
| Vampire 5e | successes, and two tens for a critical | `h::=(pool)d10>=6, c::=(pool)d10=10, c>=2?…:h>0?…:…` |
| Blades in the Dark | best of a d6 pool, three bands | `((pool)d6kh1)>=6?…:>=4?…:…` |
| Blades in the Dark | two sixes are a critical | `h::=(pool)d6=6, b::=(pool)d6kh1, h>=2?…` |
| Blades in the Dark | zero dice | `(2d6kl1)>=6?…` |
| Savage Worlds | exploding trait die against an exploding wild die | `(d8ei,d6ei)kh1` |
| Shadowrun | pool of d6s, 5 or better | `(pool)d6>=5` |
| Shadowrun | a glitch is more ones than half the pool | `g::=(pool)d6=1, (g*2)>pool?…` |
| Fate | four plus/blank/minus dice | `4[-1,0,1]+mod` |
| Year Zero | pool of d6s, sixes and banes | `s::=(pool)d6>=6, b::=(pool)d6=1, b>0?…` |
| Genesys | successes and advantages off one pool | faces encoded as `100*(at+5) + (sa+5)`, split with `/100` and `%100` |
| Burning Wheel | open-ended sixes | `3d6ei` |
| Dungeon Crawl Classics | the dice chain | `d3`, `d5`, `d7`, `d14`, `d16`, `d24`, `d30` |
| PbtA | 2d6 banded three ways | `(2d6+mod)>=10?…:>=7?…:…` |

Fractional thresholds need no rounding of their own: `/` is whole-number, and a
die only ever shows a whole number, so `d100<=33/5` means `<=6` either way.

### The three shapes most of these rest on

**Bind the roll, then read it more than once.** `::=` rolls once and every
mention is that same result, and a checked pool *counts as* its hits, so

```
h::=(pool)d6=6, h>=2?"critical":"no"
```

asks about the count rather than about the faces. The same shape reads one roll
two ways — hits and ones, successes and tens, the natural face beside the total.
Brackets alone do not do this: `((pool)d6=6)>=2` is still a set, and the
comparison distributes over it.

**Read the digits.** `/` and `%` are whole-number, so one die carries two
numbers: `roll::=d100, roll/10, roll%10`. Where a system wants two independent
counts off one pool, encoding them in separate digit ranges and splitting them
out afterwards works as long as neither can carry into the other — which is what
the Genesys preset does with a bias of 5 per die.

**Build a value out of digits.** `@` shifts a whole set at once, so digits can be
put back together as well as taken apart. Call of Cthulhu's bonus die is a second
*tens* digit sharing the first's units, which `(2d10@-1)kl1` gives directly —
`2d100kl1` is close but a different distribution.

## What it cannot say yet

Each of these is one missing capability, listed with what would close it.

### Matching faces
**Ironsworn matches**, **One Roll Engine** (width and height of matched sets),
**Tunnels & Trolls** (doubles add and roll again). Nothing can ask whether two
dice in a set show the same face.

*Wants:* a way to read groups of equal faces out of a set.

### One value against several others
**Ironsworn.** An action die is compared against two challenge dice: beating
both is a strong hit, one a weak hit, neither a miss. Both challenge dice are
rolled once and compared separately. Binding gets the dice to stay still —
`a::=d6+mod, c::=(d10,d10)` — but a comparison's right-hand side has to be a
single value, so the two cannot be compared in one go.

*Wants:* a comparison whose right-hand side is a set, counting how many members
it beats.

### Modifying the die after the fact
**Cyberpunk RED imploding d10.** A 1 means roll again and *subtract*. Exploding
adds; nothing subtracts.

*Wants:* a re-roll that subtracts, or an explode with a sign.

### Counting words
**Genesys / FFG Star Wars**, written honestly. Faces can hold the words already,
and the numeric encoding above gets the arithmetic right, but nothing counts how
often a word turns up across a set, so the faces have to be numbers pretending
to be symbols.

*Wants:* counting occurrences of a word across a set, and subtracting one count
from another.

### Picking from a mixed pool
**Cortex Prime.** Roll a pool of differently-sized dice, choose two to add for
the total and one more for the effect. Keep and drop take the highest or lowest,
never a choice made afterwards.

*Wants:* nothing automatic — this may simply be a roll a person resolves by eye.
