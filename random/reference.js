/* ============================================================================
   Random Engine — the reference panel, as data
   ----------------------------------------------------------------------------
   Each entry is [example, description, form, note].

   A ~ splits the example into scaffolding and the part that does the work
   named in the description; odd segments are coloured, even ones greyed. What
   is coloured and what is inserted are two questions — an atom always inserts
   its whole example, so colour the part that explains the line rather than the
   part you want pasted.

   form says where a click puts it: atom at the caret, suffix onto the term the
   caret is in, wrap around that term, prefix at the front, append at the end.
   note is what the row says on hover, where a rule too long for one line goes.
   The README is the last resort below that.
   ========================================================================== */
(function (global) {
  'use strict';
  /* every size that has a solid of its own, for the gallery */
  global.RandomEngineDice = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 100];

  /* Each entry is [example, description, form].
       Every example is valid on its own. A ~ toggles between the grey
       scaffolding and the coloured part that does the referenced work, so
       '4d6~kh3' greys the dice and colours the modifier.
       form: atom inserts as written; suffix hangs the coloured part off the
       term the caret is in; wrap wraps that term. */
  global.RandomEngineReference = [
    ['Dice', [
      ['~d20', 'one die — a value', 'atom', 'One die is a value, not a set. Set modifiers like kh have nothing to work on and are refused. Any positive number of sides works: a size with no solid of its own borrows the nearest one to draw with.'],
      ['~4d6', 'four dice — a set, summed when a value is needed', 'atom', 'A count makes a set. Summing is the only thing that ever turns one back into a value.'],
      ['~(2+2)~d6', 'computed quantity', 'atom', 'The bracket is worked out first and used as the number of dice.'],
      ['3d~(2*6)', 'computed number of sides', 'atom', 'Sides can be computed too, so a die can be as big as the maths makes it.']
    ]],
    ['Sets', [
      ['(d6~,~d8)', 'a set built by listing values', 'atom', 'The comma is what builds a set. Whitespace never does: d10-2d6 and d10 -2d6 are the same roll.'],
      ['~4(~d10+d6~)', 'repeat an expression into a set of 4', 'atom', '4d6 is shorthand for 4(d6). Anything can be repeated this way, not just a die.'],
      ['~2(~d10,2d6~)', 'sets inside sets unpack', 'atom', 'Nesting never compounds — the inner set is flattened into the outer one.'],
      ['(d10,~-~2d6)', 'a minus flips every member', 'atom', 'A minus in front of a set negates each member rather than the sum.'],
      ['4d6~@>=5', 'ask each member, not the total', 'suffix', 'A modifier is about the total of what it follows unless it says @. 4d6>=5 asks one question about the sum; 4d6@>=5 asks four and counts the hits. Any modifier a single member can answer for takes it — a check, a clamp, an explode, a re-roll — so d6r and 4d6@r are both ordinary. Keeping, dropping, making unique and advantage are about the set as a whole and refuse it.']
    ]],
    ['Advantage', [
      ['2d6~a', 'roll it all again, keep the better total', 'suffix', 'Everything to the left is rolled again and the better result kept. Each attempt is summed before they are compared, so this is the better total, not the better die. It has to be the last modifier.'],
      ['2d6~da', 'keep the worse total', 'suffix', 'The same, keeping the worse.'],
      ['2d6~a3', 'best of three', 'suffix', 'The number is how many attempts to make in total.'],
      ['d20~a', 'the familiar one', 'suffix', 'On a single die this is the usual advantage roll; 2d20kh1 says the same thing.']
    ]],
    ['Keep & drop', [
      ['4d6~kh3', 'keep the highest 3 — needs a set', 'suffix', 'Keep and drop need a set. On one value there is nothing to choose between, and it is refused before the roll.'],
      ['2d20~kl1', 'keep the lowest die', 'suffix', 'This picks a die. To pick between whole totals instead, use da.'],
      ['4d6~dl1', 'drop the lowest', 'suffix'],
      ['4d6~dh1', 'drop the highest', 'suffix'],
      ['(3d6,2d8)~kh3', 'best 3 across a listed set', 'suffix', 'Brackets only group. (3d6+2d8) is a value and refuses kh; (3d6,2d8) is a set and takes it.']
    ]],
    ['Exploding', [
      ['d6~e', 'roll again and add when it lands on 6', 'suffix', 'Explode needs dice, so it cannot attach to a bracket. The plain letter does it once.'],
      ['d6~ei', 'keep exploding while it hits 6', 'suffix', 'A trailing i means for as long as it keeps qualifying, up to a safety limit.'],
      ['d6~e5', 'explode on 5 or more', 'suffix'],
      ['d6~ep', 'penetrating: the extra die takes -1', 'suffix', 'Every extra roll comes in one lower.'],
      ['d6~epi', 'penetrating, repeated', 'suffix']
    ]],
    ['Re-rolling', [
      ['d6~r', 're-roll a 1, once', 'suffix', 'The new value stands. The die shows what it was before, struck out.'],
      ['d6~ri', 're-roll 1s until they stop', 'suffix', 'Repeats while it keeps qualifying.'],
      ['d6~r2', 're-roll 2 and below, once', 'suffix'],
      ['4d10~u', 'force every die to a different value', 'suffix', 'Duplicates are re-rolled. Needs dice, and a set of them.'],
      ['4d10~u3', 'give up after three attempts', 'suffix']
    ]],
    ['Results', [
      ['d6~s5', 'mark each 5+ a success — counts as 1', 'suffix', 'Writing the s says what a hit is and nothing about the rest, so a miss stays blank. A hit counts as 1, so this can still be used in a calculation.'],
      ['d6~>=5', 'the same, with s left out', 'suffix', 'A bare comparison is a plain yes or no, so it names both sides: success or failure.'],
      ['d6~f2', 'mark each 2 or less a failure', 'suffix', 'A failure check carries no number, so using it in a calculation is refused before the roll.'],
      ['d20~cs19', 'mark 19+ a critical success', 'suffix', 'A result type with no number of its own. If criticals are possible at all, the tally shows a nought when none turn up.'],
      ['d20~cf2', 'mark 2 or less a critical failure', 'suffix']
    ]],
    ['Clamp', [
      ['d6~min2', 'treat any face below 2 as 2', 'suffix', 'Clamps a face rather than re-rolling it; the die shows what it was.'],
      ['d6~max5', 'treat any face above 5 as 5', 'suffix']
    ]],
    ['Maths', [
      ['2d6~+2', 'add', 'suffix'],
      ['2d6~-2', 'subtract', 'suffix'],
      ['2d6~*2', 'multiply — the set is summed first', 'suffix', 'A set is summed before multiplying, never multiplied out member by member.'],
      ['2d6~/2', 'divide, keeping the whole part', 'suffix', 'Whole numbers only — the fraction is thrown away, toward zero, so 7/2 is 3. With % this reads the digits of a roll: d100/10 is the tens, d100%10 the units.'],
      ['2d6~%2', 'the remainder after dividing', 'suffix', 'What is left over from whole-number division. d100%10 is the units digit of a percentile roll.'],
      ['2d6~^2', 'raise to a power', 'suffix'],
      ['2d6~@*2', 'do it to each member, not to the sum', 'suffix', 'Arithmetic sums a set before touching it; @ is the way round that. One operator and one operand at a time, so 2d6@*2+3 doubles each die and then adds 3 once — write @*2@+3 to do both to each. The right side is worked out afresh per member, so 2d6@*d4 rolls a d4 for each die.'],
      ['~sum(~2d6~)', 'a set as a single value', 'wrap', 'Everything added up. A set is summed wherever a value is needed, so this is rarely necessary — except on the right of a comparison, which refuses a set rather than guessing. sum(2d6) is the total; 2d6 on its own is still two dice.'],
      ['~max(~d20,10~)', 'the largest value', 'wrap', 'Each argument is reduced to a value first, so max(2d6,7) compares the total of 2d6 against 7.'],
      ['~min(~d20,10~)', 'the smallest value', 'wrap']
    ]],
    ['Words & choices', [
      ['d20>=15~?hit:miss', 'pick between two results', 'suffix', 'The choice distributes exactly as the comparison does: 4d20>10?hit:miss is four choices, not one taken on the sum.'],
      ['~\"a long word\"', 'a quoted word, spaces allowed', 'atom'],
      ['~hit', 'a bare word — a variable if one is set', 'atom', 'A bare word becomes a variable when one of that name exists, and stays a word otherwise.'],
      ['~{atk}', 'always the variable, never a word', 'atom', 'Insists on the variable, and says so if none is set.']
    ]],
    ['Variables', [
      ['~roll:=d6~,roll,roll', 'a fresh roll at every mention', 'atom', 'A variable holds text, not a result, so every mention rolls again — this throws two dice. It has to stand as its own top-level item, and it shadows a variable of the same name in the panel.'],
      ['~roll::=d6~,roll,roll', 'rolled once, however often it is named', 'atom', 'The opposite of :=. One die, and both mentions are that same result, which is what lets a chain of comparisons ask about one roll several times. It stands for what the roll came to, so it is a value and never a set.'],
      ['~h::=4d6@=6,~h>=2?"crit":"no"', 'ask about a count of hits', 'atom', 'A checked pool counts as its hits, so binding it with ::= and comparing the name asks how many there were rather than what the dice showed.'],
      ['~atk:=d20+5,~2atk', 'set one for this expression only', 'prefix', 'Has to stand as its own top-level item. It shadows a variable of the same name in the panel, and is worked out afresh at every mention.'],
      ['~2~atk', 'used twice means rolled twice', 'atom', 'A variable holds text, not a result, so every mention is a fresh roll.']
    ]],
    ['Chained choices', [
      ['d6>4?yes~:>2?maybe:no~', 'more comparisons on the same roll', 'atom', 'An else that opens with a comparison carries on about the same subject. The subject is worked out once and each comparison tried in the order written.'],
      ['(2d6)>=10?good~:>=7?mixed:bad~', 'bracket what the chain is about', 'atom', 'A comparison binds to a term, not a sum, so 2d6+3>=10 would compare the 3. Bracket what the chain is about.']
    ]],
    ['Custom dice', [
      ['~[1,1,1,1,1,6]', 'six faces, mostly ones', 'atom', 'A die whose faces you write out. It is drawn with the shape matching the face count.'],
      ['~[hit,hit,miss]', 'faces can be words', 'atom', 'A face that is a word is written out rather than fitted onto a die.'],
      ['~[d6,d10]', 'a face can be another roll', 'atom', 'One face is picked, then whatever is written on it is worked out.'],
      ['~3~[a,b]', 'roll a custom die three times', 'atom']
    ]],
    ['Whole roll', [
      ['~6x~4d6dl1', 'repeat the whole expression 6 times', 'prefix', 'Rolls the whole expression separately that many times and reports each.'],
      ['2d6~,3d8', 'separate rolls, reported together', 'append', 'At the top level a comma starts another roll. Inside brackets the same comma builds a set.'],
      ['2d20kh1~#attack', 'label, ignored by the maths', 'append', 'The label names the roll. It is also what a saved roll or a variable is called, and saving needs one.']
    ]],
    ['Comparisons', [
      ['d6e~=6', 'exactly', 'suffix'],
      ['d6e~>=5', 'at least', 'suffix'],
      ['d6r~<=2', 'at most', 'suffix'],
      ['d6r~!=3', 'anything but', 'suffix'],
      ['d6~>d4', 'against a fresh roll each time', 'suffix', 'The other side of an explicit comparison can be any expression that works out to one value, rolled again for every comparison it takes part in.'],
      ['loot~=gem', 'against a word', 'suffix', 'Words compare by being the same word.']
    ]]
  ];

}(window));
