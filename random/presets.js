/* ============================================================================
   Random Engine — ready-made presets
   ----------------------------------------------------------------------------
   Each is a set of saved rolls and variables for one game. The first is the
   one a browser with nothing stored starts from.

   A roll is written the same way as one you would type: an expression named by
   the `# name` at its end, with `{ident}` in the name where a variable is
   written differently from how it is shown.

   SYSTEMS.md records what each system needs and what the notation cannot yet
   say — read it before adding a preset for a system with unusual dice.
   ========================================================================== */
(function (global) {
  'use strict';

  global.RandomEnginePresets = [
    {
      name: 'Dice',
      note: 'Every solid on its own, and nothing else.',
      vars: [],
      saved: [
        'd4 # <d4>', 'd6 # <d6>', 'd8 # <d8>', 'd10 # <d10>',
        'd12 # <d12>', 'd20 # <d20>', 'd100 # <d100>', '2d6 # 2x <d6>'
      ]
    },

    {
      name: 'D&D 5e',
      note: 'A d20 against a target, with advantage and disadvantage.',
      vars: ['0 # Modifier {mod}', '15 # Difficulty {dc}', '15 # Armour class {ac}'],
      saved: [
        'd20+mod # Check',
        '2d20kh1+mod # Advantage',
        '2d20kl1+mod # Disadvantage',
        '(d20+mod)>=dc?"Success":"Failure" # Check vs DC',
        '(d20+mod)>=ac?"Hit":"Miss" # Attack',
        'd20=20?"Critical hit":>=ac?"Hit":"Miss" # Attack with crits',
        '2d6+mod # Damage',
        '4d6dl1 # Ability score',
        '6x 4d6dl1 # Full array',
        'd20>=10?"Save":"Fail" # Death save',
        'd4 # Bardic inspiration'
      ]
    },

    {
      name: 'Pathfinder 2e',
      note: 'Four degrees of success, ten either side of the DC.',
      vars: ['0 # Modifier {mod}', '15 # Difficulty {dc}'],
      saved: [
        '(d20+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Check',
        '(2d20kh1+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Fortune',
        '(2d20kl1+mod)>=(dc+10)?"Critical success":>=dc?"Success":>(dc-10)?"Failure":"Critical failure" # Misfortune',
        'd20+mod # Plain check',
        '2d6+mod # Damage',
        '4d6dl1 # Ability score'
      ]
    },

    {
      name: 'Call of Cthulhu 7e',
      note: 'Roll under your skill on d100; how far under is the degree.',
      vars: ['50 # Skill {skill}'],
      saved: [
        'd100<=(skill/5)?"Extreme success":<=(skill/2)?"Hard success":<=skill?"Regular success":<100?"Failure":"Fumble" # Skill check',
        '2d100kl1 # Bonus die (roll twice, keep lower)',
        '2d100kh1 # Penalty die (roll twice, keep higher)',
        'd100 # Percentile',
        'd100<=skill?"Success":"Failure" # Pass or fail',
        'd6+d4 # Sanity loss'
      ]
    },

    {
      name: 'World of Darkness',
      note: 'A pool of d10s; every 8 or better is a success.',
      vars: ['5 # Dice pool {pool}'],
      saved: [
        '(pool)d10>=8 # Roll',
        '(pool)d10ei>=8 # Ten again',
        '(pool)d10ei>=9 # Nine again',
        'd10>=10?"Success":"Failure" # Chance die',
        '(pool)d10>=8?"Success":"Failure" # Each die, named'
      ]
    },

    {
      name: 'Blades in the Dark',
      note: 'A pool of d6s; only the best one counts.',
      vars: ['2 # Dice pool {pool}'],
      saved: [
        '((pool)d6kh1)>=6?"Full success":>=4?"Partial success":"Bad outcome" # Action roll',
        '(2d6kl1)>=6?"Full success":>=4?"Partial success":"Bad outcome" # Zero dice',
        '(pool)d6=6 # Sixes rolled',
        '(pool)d6kh1 # Best die',
        'd6+d6 # Fortune'
      ]
    },

    {
      name: 'Savage Worlds',
      note: 'A trait die and a wild die, both exploding, best one wins.',
      vars: ['0 # Modifier {mod}'],
      saved: [
        '((d8ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d8',
        '((d6ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d6',
        '((d12ei,d6ei)kh1+mod)>=8?"Raise":>=4?"Success":"Failure" # Trait d12',
        '(d8ei,d6ei)kh1+mod # Trait roll, plain',
        'd6ei # Exploding <d6>',
        '2d6+d6ei # Damage with a raise die'
      ]
    },

    {
      name: 'Shadowrun',
      note: 'A pool of d6s; every 5 or 6 is a hit.',
      vars: ['8 # Dice pool {pool}'],
      saved: [
        '(pool)d6>=5 # Hits',
        '(pool)d6=1 # Ones, for a glitch',
        '(pool)d6ei>=5 # Edge, exploding',
        '(pool)d6kh1 # Best die'
      ]
    },

    {
      name: 'Fate',
      note: 'Four dice showing plus, blank or minus, against a ladder.',
      vars: ['0 # Modifier {mod}', '2 # Difficulty {dc}'],
      saved: [
        '4[-1,0,1]+mod # Fate roll',
        '(4[-1,0,1]+mod)>=8?"Legendary":>=6?"Fantastic":>=4?"Great":>=2?"Fair":>=0?"Mediocre":>=-2?"Poor":"Terrible" # Against the ladder',
        '(4[-1,0,1]+mod)>=dc?"Success":"Failure" # Against a difficulty',
        '4[-1,0,1] # Four Fate dice'
      ]
    },

    {
      name: "Hubert's Dream",
      note: 'Two d6 and a modifier, banded four ways.',
      vars: ['0 # Modyfikatory {mod}'],
      saved: [
        'd4 # <d4>', 'd6 # <d6>', 'd8 # <d8>', 'd10 # <d10>',
        'd12 # <d12>', 'd20 # <d20>',
        '(2d6a+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut z ułatwieniem',
        '(2d6+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut zwykły',
        '(2d6da+mod)>=13?"Sukces krytyczny":>=10?"Pełny sukces":>=7?"Sukces z konsekwencją":"Porażka i konsekwencja" # Rzut z utrudnieniem'
      ]
    },

    {
      name: 'Awkward rolls',
      note: 'Unusual dice from all over, for finding out what the notation cannot yet say.',
      vars: ['3 # Dice pool {pool}', '0 # Modifier {mod}'],
      saved: [
        'd6+mod # Ironsworn action die',
        '(d10,d10) # Ironsworn challenge dice',
        '(pool)d10=10 # Vampire 5e, tens for a critical',
        '(pool)d10>=6 # Vampire 5e, successes',
        'd10ei+mod # Cyberpunk RED, exploding',
        'd10=1?"Fumble check":+mod # Cyberpunk RED, imploding on a 1',
        'd100 # Warhammer 4e, roll under',
        '(d3,d5,d7,d14,d16,d24,d30) # Dungeon Crawl Classics dice chain',
        '3d6ei # Burning Wheel, open-ended sixes',
        '(pool)d6>=6 # Year Zero, sixes',
        '(pool)d6=1 # Year Zero, ones for a bane',
        '4[blank,blank,success,advantage,"success advantage","success success"] # Genesys ability die',
        '2[blank,failure,threat,"failure threat","failure failure","threat threat"] # Genesys difficulty die',
        '(2d6,2d6)kh1 # Doubles-hunting pool',
        '10d10 # One Roll Engine pool',
        '(d20a)>=15?"Hit":"Miss" # Advantage on the whole roll',
        'x::=2d6, x>=10?"Strong":x>=7?"Weak":"Miss" # One roll, three bands'
      ]
    }
  ];
}(window));
