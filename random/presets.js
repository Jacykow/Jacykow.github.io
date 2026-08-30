/* ============================================================================
   Random Engine — ready-made presets
   ----------------------------------------------------------------------------
   Each is a set of saved rolls and variables for one game. The first is the
   one a browser with nothing stored starts from.

   A roll is written the same way as one you would type: an expression named by
   the `# name` at its end, with `{ident}` in the name where a variable is
   written differently from how it is shown. Writing it as `[expr, 'Heading']`
   puts it under one of the preset's `cats`; a bare string is loose. A heading
   is a place in the bar and the lists and nothing more — a variable under one
   is still written the same way from anywhere.

   SYSTEMS.md records what each system needs and what the notation cannot yet
   say — read it before adding a preset for a system with unusual dice.
   ========================================================================== */
(function (global) {
  'use strict';

  global.RandomEnginePresets = [
    {
      name: 'Reset',
      note: 'Every solid on its own, and nothing else — where a browser with nothing stored starts.',
      cats: ['Dice'],
      vars: [],
      saved: [
        ['d4 # <d4>', 'Dice'], ['d6 # <d6>', 'Dice'], ['d8 # <d8>', 'Dice'],
        ['d10 # <d10>', 'Dice'], ['d12 # <d12>', 'Dice'], ['d20 # <d20>', 'Dice'],
        ['d100 # <d100>', 'Dice'],
        '2d6 # 2x <d6>'
      ]
    },

    {
      name: 'D&D 5e',
      note: 'A d20 against a target, with advantage and disadvantage.',
      cats: ['Dice', 'Checks', 'Damage'],
      vars: [['0 # Modifier {mod}', 'Checks'], ['15 # Difficulty {dc}', 'Checks'],
             ['15 # Armour class {ac}', 'Checks']],
      saved: [
        ['d20 # <d20>', 'Dice'], ['d12 # <d12>', 'Dice'], ['d10 # <d10>', 'Dice'],
        ['d8 # <d8>', 'Dice'], ['d6 # <d6>', 'Dice'], ['d4 # <d4>', 'Dice'],
        ['d20+mod # Check', 'Checks'],
        ['2d20kh1+mod # Advantage', 'Checks'],
        ['2d20kl1+mod # Disadvantage', 'Checks'],
        ['(d20+mod)>=dc?"Success":"Failure" # Check vs DC', 'Checks'],
        ['(d20+mod)>=ac?"Hit":"Miss" # Attack', 'Checks'],
        ['d20=20?"Critical hit":>=ac?"Hit":"Miss" # Attack with crits', 'Checks'],
        ['d20>=10?"Save":"Fail" # Death save', 'Checks'],
        ['2d6+mod # Damage', 'Damage'],
        ['d4 # Bardic inspiration', 'Damage'],
        '4d6dl1 # Ability score',
        '6x 4d6dl1 # Full array'
      ]
    },

    {
      name: 'Pathfinder 2e',
      note: 'Four degrees of success, ten either side of the DC.',
      cats: ['Dice', 'Checks'],
      vars: [['0 # Modifier {mod}', 'Checks'], ['15 # Difficulty {dc}', 'Checks']],
      saved: [
        ['d20 # <d20>', 'Dice'], ['d12 # <d12>', 'Dice'], ['d10 # <d10>', 'Dice'],
        ['d8 # <d8>', 'Dice'], ['d6 # <d6>', 'Dice'], ['d4 # <d4>', 'Dice'],
        ['(d20+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Check', 'Checks'],
        ['(2d20kh1+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Fortune', 'Checks'],
        ['(2d20kl1+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Misfortune', 'Checks'],
        ['n::=d20, t::=n+mod, base::=t>=(dc+10)?3:>=dc?2:>(dc-10)?1:0, deg::=max(0,min(3,base+(n=20?1:n=1?-1:0))), deg=3?"Critical success":deg=2?"Success":deg=1?"Failure":"Critical failure" # Check with nat 20 and nat 1', 'Checks'],
        ['d20+mod # Plain check', 'Checks'],
        '2d6+mod # Damage',
        '4d6dl1 # Ability score'
      ]
    },

    {
      name: 'Call of Cthulhu 7e',
      note: 'Roll under your skill on d100; how far under is the degree.',
      cats: ['Dice', 'Checks'],
      vars: [['50 # Skill {skill}', 'Checks']],
      saved: [
        ['d100 # <d100>', 'Dice'], ['d10 # <d10>', 'Dice'],
        ['d6 # <d6>', 'Dice'], ['d4 # <d4>', 'Dice'],
        ['d100<=(skill/5)?"Extreme success":<=(skill/2)?"Hard success":<=skill?"Regular success":<100?"Failure":"Fumble" # Skill check', 'Checks'],
        ['u::=d10@-1, t::=(2d10@-1)kl1, v::=t*10+u, v=0?100:v # Bonus die', 'Checks'],
        ['u::=d10@-1, t::=(2d10@-1)kh1, v::=t*10+u, v=0?100:v # Penalty die', 'Checks'],
        ['d100<=skill?"Success":"Failure" # Pass or fail', 'Checks'],
        ['roll::=d100, roll/10, roll%10 # Tens and units', 'Checks'],
        'd6+d4 # Sanity loss'
      ]
    },

    {
      name: 'World of Darkness',
      note: 'A pool of d10s; every 8 or better is a success.',
      cats: ['Dice', 'Pools'],
      vars: [['5 # Dice pool {pool}', 'Pools']],
      saved: [
        ['d10 # <d10>', 'Dice'],
        ['(pool)d10>=8 # Roll', 'Pools'],
        ['(pool)d10ei>=8 # Ten again', 'Pools'],
        ['(pool)d10ei>=9 # Nine again', 'Pools'],
        ['d10>=10?"Success":"Failure" # Chance die', 'Pools'],
        ['(pool)d10>=8?"Success":"Failure" # Each die, named', 'Pools'],
        ['h::=(pool)d10>=8, c::=(pool)d10=10, c>=2?"Critical":h>0?"Success":"Failure" # With criticals', 'Pools']
      ]
    },

    {
      name: 'Blades in the Dark',
      note: 'A pool of d6s; only the best one counts.',
      cats: ['Dice', 'Action rolls'],
      vars: [['2 # Dice pool {pool}', 'Action rolls']],
      saved: [
        ['d6 # <d6>', 'Dice'],
        ['((pool)d6kh1)>=6?"Full success":>=4?"Partial success":"Bad outcome" # Action roll', 'Action rolls'],
        ['(2d6kl1)>=6?"Full success":>=4?"Partial success":"Bad outcome" # Zero dice', 'Action rolls'],
        ['h::=(pool)d6=6, b::=(pool)d6kh1, h>=2?"Critical":b>=6?"Full success":b>=4?"Partial success":"Bad outcome" # With criticals', 'Action rolls'],
        ['(pool)d6=6 # Sixes rolled', 'Action rolls'],
        ['(pool)d6kh1 # Best die', 'Action rolls'],
        'd6+d6 # Fortune'
      ]
    },

    {
      name: 'Savage Worlds',
      note: 'A trait die and a wild die, both exploding, best one wins.',
      cats: ['Dice', 'Trait rolls'],
      vars: [['0 # Modifier {mod}', 'Trait rolls']],
      saved: [
        ['d12 # <d12>', 'Dice'], ['d10 # <d10>', 'Dice'], ['d8 # <d8>', 'Dice'],
        ['d6 # <d6>', 'Dice'], ['d4 # <d4>', 'Dice'],
        ['((d8ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d8', 'Trait rolls'],
        ['((d6ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d6', 'Trait rolls'],
        ['((d12ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d12', 'Trait rolls'],
        ['(d8ei,d6ei)kh1+mod # Trait roll, plain', 'Trait rolls'],
        'd6ei # Exploding <d6>',
        '2d6+d6ei # Damage with a raise die'
      ]
    },

    {
      name: 'Shadowrun',
      note: 'A pool of d6s; every 5 or 6 is a hit.',
      cats: ['Dice', 'Pools'],
      vars: [['8 # Dice pool {pool}', 'Pools']],
      saved: [
        ['d6 # <d6>', 'Dice'],
        ['(pool)d6>=5 # Hits', 'Pools'],
        ['(pool)d6=1 # Ones, for a glitch', 'Pools'],
        ['h::=(pool)d6>=5, g::=(pool)d6=1, (g*2)>pool?"Glitch":h>0?"Hit":"Miss" # Hits and glitches', 'Pools'],
        ['(pool)d6ei>=5 # Edge, exploding', 'Pools'],
        ['(pool)d6kh1 # Best die', 'Pools']
      ]
    },

    {
      name: 'Fate',
      note: 'Four dice showing plus, blank or minus, against a ladder.',
      cats: ['Rolls'],
      vars: [['0 # Modifier {mod}', 'Rolls'], ['2 # Difficulty {dc}', 'Rolls']],
      saved: [
        ['4[-1,0,1]+mod # Fate roll', 'Rolls'],
        ['(4[-1,0,1]+mod)>=8?"Legendary":>=6?"Fantastic":>=4?"Great":>=2?"Fair":>=0?"Mediocre":>=-2?"Poor":"Terrible" # Against the ladder', 'Rolls'],
        ['(4[-1,0,1]+mod)>=dc?"Success":"Failure" # Against a difficulty', 'Rolls'],
        ['4[-1,0,1] # Four Fate dice', 'Rolls']
      ]
    },

    {
      name: "Hubert's Dream",
      note: 'Two d6 and a modifier, banded four ways.',
      cats: ['Kości', 'Rzuty'],
      vars: [['0 # Modyfikatory {mod}', 'Rzuty']],
      saved: [
        ['d4 # <d4>', 'Kości'], ['d6 # <d6>', 'Kości'], ['d8 # <d8>', 'Kości'],
        ['d10 # <d10>', 'Kości'], ['d12 # <d12>', 'Kości'], ['d20 # <d20>', 'Kości'],
        ['(2d6a+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut z ułatwieniem', 'Rzuty'],
        ['(2d6+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut zwykły', 'Rzuty'],
        ['(2d6da+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut z utrudnieniem', 'Rzuty']
      ]
    },

    {
      name: 'Awkward rolls',
      note: 'Unusual dice from all over, for finding out what the notation cannot yet say.',
      cats: ['Two readings', 'Digits', 'Still out of reach'],
      vars: [['3 # Dice pool {pool}', 'Two readings'], ['0 # Modifier {mod}', 'Two readings']],
      saved: [
        ['h::=(pool)d10>=6, c::=(pool)d10=10, c>=2?"Critical":h>0?"Success":"Failure" # Vampire 5e, successes and tens', 'Two readings'],
        ['h::=(pool)d6>=5, g::=(pool)d6=1, (g*2)>pool?"Glitch":h>0?"Hit":"Miss" # Shadowrun, hits and glitches', 'Two readings'],
        ['s::=(pool)d6>=6, b::=(pool)d6=1, b>0?"Bane":s>0?"Success":"Failure" # Year Zero, sixes and banes', 'Two readings'],
        ['roll::=d100, roll/10, roll%10 # Percentile, tens and units', 'Digits'],
        ['roll::=d100, roll<=50?"Success":"Failure", roll%10 # Warhammer 4e, roll and its units', 'Digits'],
        ['g::=2[505,506,506,507,605,605,705,606]+2[505,504,503,405,405,405,305,404], (g%100)-20, (g/100)-20 # Genesys, successes then advantages', 'Digits'],
        ['d6+mod # Ironsworn action die', 'Still out of reach'],
        ['(d10,d10) # Ironsworn challenge dice', 'Still out of reach'],
        ['d10ei+mod # Cyberpunk RED, exploding', 'Still out of reach'],
        ['d10=1?"Fumble check":+mod # Cyberpunk RED, imploding on a 1', 'Still out of reach'],
        ['(2d6,2d6)kh1 # Doubles-hunting pool', 'Still out of reach'],
        ['10d10 # One Roll Engine pool', 'Still out of reach'],
        '(d3,d5,d7,d14,d16,d24,d30) # Dungeon Crawl Classics dice chain',
        '3d6ei # Burning Wheel, open-ended sixes',
        '2d6@^2 # Every die squared',
        '(d20a)>=15?"Hit":"Miss" # Advantage on the whole roll',
        'x::=2d6, x>=10?"Strong":x>=7?"Weak":"Miss" # One roll, three bands'
      ]
    }
  ];
}(window));
