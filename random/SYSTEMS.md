# Dice systems, and what the notation cannot yet say

The presets in `presets.js` cover the common shapes. This is the record of what
each system actually asks for, so the awkward ones can be taken one at a time
rather than rediscovered.

Rolls marked **works** are in a preset already. The rest are why the
**Awkward rolls** preset exists: each entry there is the closest the notation
currently gets, and this file says what the game really wants.

## What works

| System | Roll | Written as |
|---|---|---|
| D&D 5e | d20 vs a target, advantage, disadvantage | `d20+mod`, `2d20kh1+mod`, `2d20kl1+mod` |
| D&D 5e | ability scores | `4d6dl1`, `6x 4d6dl1` |
| Pathfinder 2e | four degrees, ten either side of the DC | `(d20+mod)>=(dc+10)?…:>=dc?…:>(dc-10)?…:…` |
| Call of Cthulhu 7e | roll under, with degrees | `d100<=(skill/5)?…:<=(skill/2)?…:<=skill?…:…` |
| World of Darkness | pool of d10s, 8 or better | `(pool)d10>=8` |
| World of Darkness | ten-again | `(pool)d10ei>=8` |
| Blades in the Dark | best of a d6 pool, three bands | `((pool)d6kh1)>=6?…:>=4?…:…` |
| Blades in the Dark | zero dice | `(2d6kl1)>=6?…` |
| Savage Worlds | exploding trait die against an exploding wild die | `(d8ei,d6ei)kh1` |
| Shadowrun | pool of d6s, 5 or better | `(pool)d6>=5` |
| Fate | four plus/blank/minus dice | `4[-1,0,1]+mod` |
| Year Zero | pool of d6s, sixes | `(pool)d6>=6` |
| Burning Wheel | open-ended sixes | `3d6ei` |
| Dungeon Crawl Classics | the dice chain | `d3`, `d5`, `d7`, `d14`, `d16`, `d24`, `d30` |
| Genesys | narrative dice as faces | `4[blank,success,advantage,…]` |
| PbtA | 2d6 banded three ways | `(2d6+mod)>=10?…:>=7?…:…` |

Fractional thresholds need no rounding of their own: a die only ever shows a
whole number, so `d100<=33/5` already means `<=6`.

## What it cannot say yet

Each of these is one missing capability, listed with what would close it.

### Two readings of one roll
**Shadowrun glitch**, **Year Zero banes**, **Vampire 5e criticals.** A pool is
read twice: once for hits and once for something else — ones for a glitch, tens
for a critical. Only the last check on a term survives, so the two readings need
two rolls, which are two different rolls.

*Wants:* several checks on one term, each reported separately.

### Counting, then comparing that count
**Shadowrun glitch** again: a glitch is *more ones than half the pool*.
**Blades in the Dark critical**: *two or more sixes*. The count exists — `(pool)d6=1`
gives it — but nothing can then compare it against another number in the same
expression.

*Wants:* the result of a check usable as a number on the left of another
comparison, e.g. `((pool)d6=6)>=2`.

### One value against several others
**Ironsworn.** An action die is compared against two challenge dice: beating
both is a strong hit, one a weak hit, neither a miss. Both challenge dice are
rolled once and compared separately.

*Wants:* a comparison whose right-hand side is a set, counting how many members
it beats.

### Matching faces
**Ironsworn matches**, **One Roll Engine** (width and height of matched sets),
**Tunnels & Trolls** (doubles add and roll again). Nothing can ask whether two
dice in a set show the same face.

*Wants:* a way to read groups of equal faces out of a set.

### Reading digits
**Call of Cthulhu bonus die.** The bonus die is a second *tens* die sharing the
units digit of the first — not a second whole d100. `2d100kl1` is close but not
the same distribution. **Warhammer 4e** success levels compare the tens digit of
the roll against the tens digit of the skill.

*Wants:* whole-number division or a tens/units reading. `/10` gives a fraction,
and there is no floor.

### Modifying the die after the fact
**Cyberpunk RED imploding d10.** A 1 means roll again and *subtract*. Exploding
adds; nothing subtracts.

*Wants:* a re-roll that subtracts, or an explode with a sign.

### Symbol arithmetic
**Genesys / FFG Star Wars.** Faces carry successes, advantages, threats and
failures; successes cancel failures and advantages cancel threats, and what is
left is the result. Faces can hold the words already, but nothing counts and
cancels them.

*Wants:* counting occurrences of a word across a set, and subtracting one count
from another.

### Picking from a mixed pool
**Cortex Prime.** Roll a pool of differently-sized dice, choose two to add for
the total and one more for the effect. Keep and drop take the highest or lowest,
never a choice made afterwards.

*Wants:* nothing automatic — this may simply be a roll a person resolves by eye.

### Stepping a result up or down
**Pathfinder 2e** natural 20 and natural 1 shift the degree of success one step,
which needs both the raw die and the total in the same condition. The preset
ignores this.

*Wants:* the natural face of a die readable alongside the total — or two checks
on one roll, as above.
