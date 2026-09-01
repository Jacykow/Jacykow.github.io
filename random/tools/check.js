/* ============================================================================
   Random Engine — the checks worth running before committing an engine change
   ----------------------------------------------------------------------------
       node tools/check.js          about a minute
       node tools/check.js full     ten times the samples, for a real change

   There is no test framework here and no assertions library. `engine.js` is
   pure and loads under Node with two stubs, which is all any of this needs.

   Five checks, in order of how much they are worth:

     exact vs run   Wherever `distribution()` claims an exact answer, throw the
                    same expression a great many times and see whether the two
                    agree. Two independent answers agreeing is the only
                    evidence either is right, and this is what catches solver
                    bugs — every one so far.
     presets        Every expression that ships has to parse, roll, draw,
                    explain and survive being re-rolled from its own notation.
     round trip     `plain(parse(x))` re-parsed must mean the same thing, or a
                    saved roll quietly changes when it is reloaded.
     means          A handful of known values, so a change that shifts the
                    arithmetic by a little is not mistaken for noise.
     fuzz           Nonsense in. A DiceError is a fine answer; anything else,
                    or a non-finite total, is a bug in the engine.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.window = {};
// modern Node already has a global crypto, and will not let it be replaced
if (typeof crypto === 'undefined') global.crypto = require('crypto').webcrypto;
new Function(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'presets.js'), 'utf8'))();
new Function(fs.readFileSync(path.join(ROOT, 'reference.js'), 'utf8'))();
const E = window.DiceEngine;

const FULL = process.argv.indexOf('full') > 0;
const N = FULL ? 120000 : 12000;      // rolls per expression in the exact check
const FUZZ = FULL ? 40000 : 8000;

let failed = 0;
const fail = (what, why) => { failed++; console.log('  !! ' + what + '\n     ' + why); };
const head = (s) => console.log('\n' + s);

/* a preset item is its expression, or that and the category it sits under */
const item = (x) => Array.isArray(x) ? String(x[0]) : String(x);
const varsOf = (preset) => {
  const map = {};
  for (const v of (preset.vars || []).map(item)) {
    const cut = E.splitLabel(v);
    const m = /\{([a-zA-Z_]+)\}/.exec(cut.label || '');
    map[m ? m[1] : (cut.label || '').trim()] = v;
  }
  return map;
};

/* ------------------------------------------------------- exact vs the run
   One word is the result; several are a score, counted rather than ordered,
   which is how the solver answers and so how the run has to be read. */
function outcome(r) {
  const words = r.words.concat(Object.keys(r.tally).filter((w) => r.words.indexOf(w) < 0));
  let held = 0;
  for (const w of words) held += r.tally[w] || 0;
  return held > 1 ? words.map((w) => (r.tally[w] || 0) + ' ' + w).join(' - ') : r.text;
}

function exactAgrees(src) {
  let d = null;
  try { d = E.distribution(src); } catch (e) { return 0; }
  if (!d) return 0;

  if (d.words) {
    const tally = {};
    for (let i = 0; i < N; i++) { const t = outcome(E.roll(src)); tally[t] = (tally[t] || 0) + 1; }
    // a long list of scores is cut short by the solver, so the tail is untested
    const whole = d.words.size < E.LIMIT.combos;
    for (const w in tally) {
      if (whole && !d.words.has(w)) { fail(src, 'the run turned up "' + w + '", which the exact answer never names'); return 1; }
    }
    for (const [w, p] of d.words) {
      const seen = (tally[w] || 0) / N;
      // an outcome the exact answer rules out must never actually happen
      if (p === 0 && tally[w]) {
        fail(src, '"' + w + '" cannot happen, and happened ' + tally[w] + ' times');
        return 1;
      }
      /* Four and a half standard errors, with a floor for the short run. The
         check makes hundreds of these comparisons, so a threshold tight enough
         to be interesting on one of them would cry wolf on every run. */
      const tol = Math.max(0.015, 4.5 * Math.sqrt(Math.max(p * (1 - p), 1e-4) / N));
      if (Math.abs(seen - p) > tol) {
        fail(src, '"' + w + '" exact ' + (p * 100).toFixed(2) + '%, run ' + (seen * 100).toFixed(2) + '%');
        return 1;
      }
    }
    return 1;
  }

  let sum = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) {
    const t = E.roll(src).total;
    sum += t; if (t < lo) lo = t; if (t > hi) hi = t;
  }
  const off = Math.abs(sum / N - d.mean);
  const tol = Math.max(0.05, 6 * d.stdev / Math.sqrt(N));
  if (off > tol) fail(src, 'mean exact ' + d.mean.toFixed(4) + ', run ' + (sum / N).toFixed(4));
  else if (lo < d.min || hi > d.max) fail(src, 'saw [' + lo + '..' + hi + '] outside [' + d.min + '..' + d.max + ']');
  return 1;
}

head('exact answers against the run  (' + N.toLocaleString() + ' rolls each)');
let claimed = 0, looked = 0;
for (const preset of window.RandomEnginePresets) {
  E.setVars(varsOf(preset));
  for (const src of (preset.saved || []).map(item)) {
    looked++;
    claimed += exactAgrees(E.splitLabel(src).body);
  }
}
/* and a generated sweep over the shapes the solver claims to know */
E.setVars({ mod: '3', pool: '5', atk: 'd20+5' });
{
  const ATOM = ['d6', 'd20', '4d6', '3d10', 'd4', '2', '7', 'mod', 'atk', '[1,2,3]', '[0,0,1]',
                'd100', '3.0', '2.5'];
  const MOD = ['', 'kh2', 'kl1', 'dl1', 'a', 'da', 'min3', 'max4', 'r1', 'ri2', '@*2', '@+1', '>=4', 's>=3'];
  const OP = ['+', '-', '*', '/', '%'];
  // a question put to every member of a set, which is answered as a score
  const SET = ['2d6', '4d6', '3d10', '10d2', '2(d20)', '3([gold,gem,dust])', '2([a,b])'];
  const ASK = ['@>=4?hit:miss', '@=1?one:other', '@>=5?"a":"b"', '@=20?crit:>=10?hit:miss', ''];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  for (let i = 0; i < (FULL ? 400 : 120); i++) {
    const r = Math.random();
    let src;
    if (r < 0.4) src = pick(ATOM) + pick(MOD);
    else if (r < 0.6) src = pick(ATOM) + pick(OP) + pick(ATOM);
    else if (r < 0.75) src = '(' + pick(ATOM) + ',' + pick(ATOM) + ')';
    else if (r < 0.85) src = Math.ceil(Math.random() * 3) + '(' + pick(ATOM) + '+1)';
    else if (r < 0.93) src = '(' + pick(ATOM) + '+mod)>=8?"good":>=4?"ok":"bad"';
    else src = pick(SET) + pick(ASK);
    try { E.roll(src); } catch (e) { continue; }
    looked++;
    claimed += exactAgrees(src);
  }
}
console.log('  ' + claimed + ' of ' + looked + ' expressions answered exactly, and checked');

/* --------------------------------------------------------------- presets */
head('every preset expression');
let rolled = 0;
for (const preset of window.RandomEnginePresets) {
  E.setVars(varsOf(preset));
  for (const v of (preset.vars || []).map(item)) {
    try { E.parse(E.splitLabel(v).body); }
    catch (e) { fail(preset.name + ' / ' + v, e.message); }
  }
  for (const src of (preset.saved || []).map(item)) {
    const body = E.splitLabel(src).body;
    try {
      const r = E.roll(body);
      r.sets.forEach((s) => s.html());
      r.sets.forEach((s) => s.html({ plain: true }));
      E.inspect(body);
      E.preview(body);
      E.analyse(body, 60);
      E.outcomes(body);
      E.roll(r.notation);               // what it prints must mean what it meant
      rolled++;
    } catch (e) { fail(preset.name + ' / ' + body, e.message); }
  }
}
console.log('  ' + rolled + ' expressions rolled, drawn, explained and re-rolled');

head('every reference example');
E.setVars({ atk: 'd20+5' });
let refs = 0;
for (const [group, rows] of window.RandomEngineReference) {
  for (const row of rows) {
    const src = row[0].split('~').join('');
    try { E.roll(src); E.inspect(src); refs++; }
    catch (e) { fail(group + ' / ' + src, e.message); }
  }
}
console.log('  ' + refs + ' examples, each a valid expression on its own');

/* ------------------------------------------------------- known mean values */
head('known values');
const MEANS = [
  ['4d6dl1', 12.244598765432098], ['2d20kh1', 13.825], ['2d20kl1', 7.175],
  ['2d6', 7], ['d20a', 13.825], ['d6r1', 141 / 36], ['d6ri1', 4],
  ['d100/10', 4.6], ['d100%10', 4.5], ['2d6@^2', 91 / 3]
];
E.setVars({});
for (const [src, want] of MEANS) {
  const d = E.distribution(src);
  if (!d || !d.pmf) { fail(src, 'no exact answer, so nothing to compare'); continue; }
  if (Math.abs(d.mean - want) > 1e-9) fail(src, 'mean ' + d.mean + ', wanted ' + want);
}
console.log('  ' + MEANS.length + ' means against their analytic values');

/* ------------------------------------------------------------------ fuzz */
head('nonsense  (' + FUZZ.toLocaleString() + ' generated expressions)');
E.setVars({ atk: 'd20+5', sneak: '3d6', loot: '[gold,gem,"rusty sword",nothing]',
            bonus: '3', loop: 'loop+1' });
{
  const ATOM = ['d6', 'd20', '4d6', '2d10', 'd4', '12', '3', 'atk', 'sneak', 'loot', 'bonus',
                'hit', '"a word"', '{atk}', '[1,2,6]', '[a,b]', 'loop', 'd100', '0'];
  const MOD = ['', 'a', 'da', 'a3', 'kh2', 'kl1', 'dl1', 'dh1', 'e', 'ei', 'ep', 'r', 'ri', 'r2',
               'u', 'u3', '@*2', '@^2', '@-1', '@/3', '@%4', '@*d4', '@*2@+1', 'min2', 'max5',
               's5', '>=4', 'f2', 'cs6', 'cf1', '>d4', '=gem', '>=atk'];
  const OP = ['+', '-', '*', '/', '%', '^'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const gen = (d) => {
    const r = Math.random();
    if (d > 3 || r < 0.34) return pick(ATOM) + pick(MOD);
    if (r < 0.5) return gen(d + 1) + pick(OP) + gen(d + 1);
    if (r < 0.62) return '(' + gen(d + 1) + ',' + gen(d + 1) + ')' + pick(MOD);
    if (r < 0.72) return '(' + gen(d + 1) + ')' + pick(MOD);
    if (r < 0.82) return Math.ceil(Math.random() * 4) + '(' + gen(d + 1) + ')' + pick(MOD);
    if (r < 0.86) return gen(d + 1) + '?' + gen(d + 1) + ':' + gen(d + 1);
    if (r < 0.9) return pick(ATOM) + pick(['>3', '<4', '>=2', '=5']) + '?' + gen(d + 1) +
      ':' + pick(['>1', '<=2', '!=3']) + '?' + gen(d + 1) + ':' + gen(d + 1);
    if (r < 0.95) return pick(['max', 'min']) + '(' + gen(d + 1) + ',' + gen(d + 1) + ')';
    return '-' + gen(d + 1);
  };

  let ok = 0, refused = 0;
  const seen = new Map();
  for (let i = 0; i < FUZZ; i++) {
    const src = gen(0);
    try {
      const r = E.roll(src);
      r.sets.forEach((s) => s.html());
      r.sets.forEach((s) => s.html({ plain: true }));
      E.inspect(src);
      E.preview(src);
      const st = E.study(src);
      st.run(4);
      st.snapshot();
      if (r.numeric && (typeof r.total !== 'number' || !isFinite(r.total))) {
        throw new Error('a numeric roll with a total of ' + r.total);
      }
      ok++;
    } catch (e) {
      if (e.name === 'DiceError') { refused++; continue; }
      const key = e.name + ': ' + e.message.slice(0, 90);
      if (!seen.has(key)) { seen.set(key, src); fail(key, 'from: ' + src); }
    }
  }
  console.log('  ' + ok + ' rolled, ' + refused + ' refused with a DiceError');
}

console.log(failed ? '\n' + failed + ' FAILED' : '\nall good');
process.exit(failed ? 1 : 0);
