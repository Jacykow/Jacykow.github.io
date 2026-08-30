/* ============================================================================
   Random Engine — dice notation parser, evaluator & explainer
   ----------------------------------------------------------------------------
   No DOM, no dependencies. Exposes window.DiceEngine; app.js does the rest.

   TYPES. There are exactly two structural types, and everything follows:

     value   one thing
     set     an ordered collection of values

   A set becomes a value by being SUMMED — the only implicit reduction there
   is. `,` builds a set, `N(expr)` repeats an expression into one, and `4d6` is
   sugar for `4(d6)`. A set inside a set unpacks, so nesting never compounds.
   Brackets only group: `(3d6+2d8)` is a value, `(3d6,2d8)` is a set, which is
   why `kh` attaches to the second and not the first.

   A value is a number, or a word. Words carry no number, so a word can only
   ever be a result. Comparing produces one: `d6>4` reads success or failure.

   MODIFIERS declare the type they need, so every mismatch is caught before
   anything is rolled:

     die       e, r, u                   need dice to re-roll
     element   min, max, s, f, cs, cf    applied to each member in turn
     set       kh, kl, dh, dl            need a collection, error on a value
     repeat    a, da                     roll the whole term again and choose

   Element modifiers distribute, and so does `?:` — `4d20>5?hit:miss` is four
   comparisons and four choices, never one taken on the sum.

   CHECKS. `s` says what a hit is and nothing about the rest, so its misses
   stay blank; a bare comparison is a plain yes/no and names both sides. Only
   the success check casts to a number (1/0). `f`, `cs` and `cf` are terminal
   result types: using one as an operand is rejected before the roll.

   GRAMMAR (recursive descent, one Parser per top-level item; every node keeps
   the source span it came from, which is what drives highlighting and Explain):

     expr    := sum ['?' expr ':' (expr | chain)]
     chain   := comparison '?' expr ':' (expr | chain)
     sum     := term (('+' | '-') term)*
     term    := power (('*' | '/' | '%') power)*
     power   := unary (('^' | '**') power)?
     unary   := ('-' | '+')? primary
     primary := number ['(' list ')' | 'd' sides | word | custom] modifier*
              | '(' list ')' modifier*  | '[' list ']' modifier*
              | func '(' list ')'       | '{' name '}' modifier*
              | '"' text '"' modifier*  | word modifier*
              | 'd' sides modifier*
     list    := expr (',' expr)*
     modifier:= name [comparison]
     comparison := ('=' | '!=' | '<' | '>' | '<=' | '>=') (integer | primary)

   A modifier's comparison takes a plain integer where there is one, and
   otherwise a primary — so `3d6>=5+1` is `(3d6>=5)+1` rather than a surprise,
   while `4d6>d4` rolls a fresh d4 for every comparison it makes.

   An else that opens with a comparison carries on about the same subject:
   `d6>4?yes:>2?maybe:no` works the subject out once and tries each comparison
   in turn, which is the only way to sort one roll into more than two outcomes.

   A top-level item of the form `name := expr` defines a variable for that one
   expression. Variables hold source text and are re-parsed and re-rolled at
   every occurrence, which is why `2atk` really is two rolls. `name ::= expr`
   is its opposite: rolled once, and every mention is that same result.
   ========================================================================== */
(function (global) {
  'use strict';

  const LIMIT = {
    qty: 5000, sides: 1000000, explode: 500, reroll: 500,
    totalDice: 20000, repeat: 1000, varDepth: 24
  };

  /* ------------------------------------------------------------------- rng */
  const rng = (function () {
    const buf = new Uint32Array(1024);
    let idx = buf.length;
    const crypt = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    function next() {
      if (idx >= buf.length) {
        if (crypt) crypt.getRandomValues(buf);
        else for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 4294967296) >>> 0;
        idx = 0;
      }
      return buf[idx++] / 4294967296;
    }
    return { int(min, max) { return min + Math.floor(next() * (max - min + 1)); } };
  }());

  /* the only two functions left: both reduce a collection to one value */
  const FUNCS = { max: Math.max, min: Math.min };
  const FUNC_DESC = { max: 'the largest value', min: 'the smallest value' };

  /* which structural type each modifier needs, and the order they run in */
  const MODS = {
    min: { kind: 'element', order: 1 },
    max: { kind: 'element', order: 2 },
    explode: { kind: 'die', order: 3 },
    reroll: { kind: 'die', order: 4 },
    unique: { kind: 'set', order: 5, dice: true },
    keep: { kind: 'set', order: 6 },
    drop: { kind: 'set', order: 7 },
    check: { kind: 'element', order: 8 },
    /* Advantage is the odd one out: every other modifier reshapes what a roll
       produced, while this one rolls the whole term again. It is handled where
       evaluation begins rather than in applyMods, and has to be written last. */
    adv: { kind: 'repeat', order: 9 }
  };

  /* The four checks. Only `s` carries a number through to arithmetic.
     Writing the `s` says what counts as a hit and nothing at all about the
     rest, so a miss stays blank. A bare comparison is a plain yes/no, so
     there a miss really is a failure. */
  const CHECKS = {
    s: { castable: true, hit: 'success', miss: null, bareMiss: 'failure', label: 'Success check' },
    f: { castable: false, hit: 'failure', miss: null, label: 'Failure check' },
    cs: { castable: false, hit: 'critSuccess', miss: null, label: 'Critical success' },
    cf: { castable: false, hit: 'critFail', miss: null, label: 'Critical failure' }
  };
  /* best to worst — the order the result tally is read in */
  const MARK_ORDER = ['critSuccess', 'success', 'failure', 'critFail'];

  /** the word a resolved check reads as, or null when it says nothing */
  function checkWord(c) {
    const spec = CHECKS[c.kind];
    if (c.hit) return spec.hit;
    return (c.bare && spec.bareMiss) ? spec.bareMiss : spec.miss;
  }

  /** every result type a check modifier could produce */
  function checkMarks(m, out) {
    const spec = CHECKS[m.check];
    if (spec.hit) out.add(spec.hit);
    const miss = (m.bare && spec.bareMiss) ? spec.bareMiss : spec.miss;
    if (miss) out.add(miss);
  }

  class DiceError extends Error {
    constructor(msg, pos) { super(msg); this.name = 'DiceError'; this.pos = pos; }
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => !isFinite(n) ? String(n)
    : (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
  /* The other side of a comparison is either a literal or an expression, in
     which case it is worked out afresh for every comparison it takes part in. */
  const cpSrc = (cp) => cp.node ? plain(cp.node) : fmt(cp.v);
  const cpText = (cp) => cp ? cp.op + cpSrc(cp) : '';

  /* nodes inside a variable are namespaced away, so hovering a d20 in the
     expression never lights up an unrelated d20 the variable happened to roll */
  const uidOf = (node, ctx) => (ctx && ctx.mute) ? 0 : node.uid;

  /* ==========================================================================
     PARSER
     ========================================================================== */
  class Parser {
    constructor(src, uidBase) { this.s = src; this.i = 0; this.uid = uidBase || 0; }

    fail(msg) { throw new DiceError(msg, this.i); }
    ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++; }
    end() { this.ws(); return this.i >= this.s.length; }
    peek() { this.ws(); return this.s[this.i]; }
    mark() { this.ws(); return this.i; }

    lit(str) {
      this.ws();
      if (this.s.substr(this.i, str.length).toLowerCase() === str.toLowerCase()) {
        this.i += str.length;
        return true;
      }
      return false;
    }

    digits() {
      this.ws();
      const m = /^\d+/.exec(this.s.slice(this.i));
      if (!m) return null;
      this.i += m[0].length;
      return parseInt(m[0], 10);
    }

    number() {
      this.ws();
      const m = /^\d+(\.\d+)?/.exec(this.s.slice(this.i));
      if (!m) return null;
      this.i += m[0].length;
      return parseFloat(m[0]);
    }

    signedInt() {
      this.ws();
      const m = /^-?\d+/.exec(this.s.slice(this.i));
      if (!m) return null;
      this.i += m[0].length;
      return parseInt(m[0], 10);
    }

    parse() {
      const node = this.expr();
      if (!this.end()) this.fail('unexpected "' + this.s[this.i] + '"');
      return node;
    }

    atComparison() {
      this.ws();
      return /^(<=|>=|!=|<>|=|<|>)/.test(this.s.slice(this.i));
    }

    /** cond ? a : b — the condition has to read as success or failure */
    expr() {
      const cond = this.sum();
      const q = this.mark();
      if (!this.lit('?')) return cond;
      const yes = this.expr();
      const cA = this.mark();
      if (!this.lit(':')) this.fail('expected ":" to finish the ? : choice');
      // an else that opens with a comparison carries on about the same thing
      if (this.atComparison()) return this.band(cond, yes, q, cA);
      const no = this.expr();
      return {
        t: 'ternary', cond, yes, no, uid: ++this.uid,
        qSp: [q, q + 1], cSp: [cA, cA + 1], sp: [cond.sp ? cond.sp[0] : q, this.i]
      };
    }

    /* `d6>4?yes:>2?maybe:no` — one subject, tried against each comparison in
       turn. The first comparison is written against the subject, so it has to
       be lifted back off it to leave the thing every arm is talking about. */
    band(cond, first, q, cA) {
      const mods = cond.mods || [];
      const lead = mods.filter((m) => m.t === 'check').pop();
      if (!lead) {
        this.i = cA;
        // a comparison binds to a term, so `2d6+m>=13` compared m and not the sum
        this.fail(cond.t === 'bin'
          ? 'a chain of comparisons is about one thing — bracket what it compares, ' +
            'like (2d6+3)>=13?crit:>=10?good:bad'
          : 'a chain of comparisons needs the first one written out, ' +
            'like d6>4?yes:>2?maybe:no');
      }
      const subject = Object.assign({}, cond, { mods: mods.filter((m) => m !== lead) });
      const arms = [{ cp: lead.cp, check: lead.check, bare: !!lead.bare,
                      then: first, sp: lead.sp, qSp: [q, q + 1], cSp: [cA, cA + 1] }];
      for (;;) {
        const a = this.mark();
        const cp = this.comparePoint();
        if (!cp) this.fail('expected a comparison after ":"');
        const qq = this.mark();
        if (!this.lit('?')) this.fail('expected "?" after the comparison');
        const then = this.expr();
        const cc = this.mark();
        if (!this.lit(':')) this.fail('expected ":" to finish the choice');
        arms.push({ cp, check: 's', bare: true, then, sp: [a, qq],
                    qSp: [qq, qq + 1], cSp: [cc, cc + 1] });
        if (this.atComparison()) continue;
        return {
          t: 'band', subject, arms, otherwise: this.expr(), uid: ++this.uid,
          sp: [cond.sp ? cond.sp[0] : q, this.i]
        };
      }
    }

    sum() {
      let l = this.term();
      for (;;) {
        const a = this.mark();
        if (this.lit('+')) l = { t: 'bin', op: '+', opSp: [a, this.i], uid: ++this.uid, l, r: this.term() };
        else if (this.lit('-')) l = { t: 'bin', op: '-', opSp: [a, this.i], uid: ++this.uid, l, r: this.term() };
        else return l;
      }
    }

    term() {
      let l = this.power();
      for (;;) {
        const a = this.mark();
        if (this.lit('**')) l = { t: 'bin', op: '^', opSp: [a, this.i], uid: ++this.uid, l, r: this.power() };
        else if (this.lit('*')) l = { t: 'bin', op: '*', opSp: [a, this.i], uid: ++this.uid, l, r: this.power() };
        else if (this.lit('/')) l = { t: 'bin', op: '/', opSp: [a, this.i], uid: ++this.uid, l, r: this.power() };
        else if (this.lit('%')) l = { t: 'bin', op: '%', opSp: [a, this.i], uid: ++this.uid, l, r: this.power() };
        else return l;
      }
    }

    power() {
      const base = this.unary();
      const a = this.mark();
      if (this.lit('**') || this.lit('^')) {
        return { t: 'bin', op: '^', opSp: [a, this.i], uid: ++this.uid, l: base, r: this.power() };
      }
      return base;
    }

    unary() {
      const a = this.mark();
      if (this.lit('-')) return { t: 'neg', opSp: [a, this.i], v: this.unary() };
      if (this.lit('+')) return this.unary();
      return this.primary();
    }

    /** cursor sits on a `d` that starts a dice spec */
    atDice() {
      this.ws();
      const c = this.s[this.i];
      if (c !== 'd' && c !== 'D') return false;
      const rest = this.s.slice(this.i + 1).replace(/^\s*/, '');
      return /^\d/.test(rest) || rest[0] === '(';
    }

    /** comma-separated expressions inside brackets */
    list() {
      const items = [this.expr()], commas = [];
      for (;;) {
        const a = this.mark();
        if (!this.lit(',')) break;
        commas.push([a, this.i]);
        items.push(this.expr());
      }
      return { items, commas };
    }

    primary() {
      const a = this.mark();
      if (this.end()) this.fail('unexpected end of expression');

      if (this.atDice()) return this.dice(null, a);

      const fn = /^([a-z]+)\s*\(/i.exec(this.s.slice(this.i));
      if (fn) {
        const name = fn[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(FUNCS, name)) {
          this.fail('unknown function "' + name + '" — only max and min remain');
        }
        const nameSp = [a, a + fn[1].length];
        this.i += fn[0].length;
        const openSp = [this.i - 1, this.i];
        const { items } = this.list();
        const cA = this.mark();
        if (!this.lit(')')) this.fail('expected ")" to close ' + name + '()');
        return { t: 'func', name, args: items, nameSp, brk: [openSp, [cA, this.i]], sp: [a, this.i] };
      }

      if (this.peek() === '(') return this.bracket(a, null);
      if (this.peek() === '[') return this.custom(a);
      if (this.peek() === '{') return this.varRef(a);
      if (this.peek() === '"') return this.quoted(a);

      const nA = this.mark();
      const n = this.number();
      if (n !== null) {
        const numNode = { t: 'num', v: n, sp: [nA, this.i] };
        if (this.atDice()) return this.dice(numNode, a);
        // a count in front of anything repeatable builds a set: 4(...), 2int, 3[a,b]
        const c = this.peek();
        if (c === '(') return this.bracket(a, numNode);
        if (c === '[' || c === '{' || /[a-zA-Z_]/.test(c || '')) {
          const one = this.primary();
          return {
            t: 'rep', count: numNode, items: [one], commas: [], mods: this.modifiers(),
            brk: [[nA, nA], [this.i, this.i]], core: [a, this.i], sp: [a, this.i], uid: ++this.uid
          };
        }
        return numNode;
      }

      const word = this.word();
      if (word) return word;

      this.fail('unexpected "' + this.s[this.i] + '"');
    }

    /** a bare word: a variable if one is defined, otherwise just a word */
    word() {
      this.ws();
      const m = /^[a-zA-Z_]+/.exec(this.s.slice(this.i));
      if (!m) return null;
      const a = this.i;
      this.i += m[0].length;
      return { t: 'word', name: m[0], sp: [a, this.i], mods: this.modifiers(), uid: ++this.uid };
    }

    /** `"anything at all"` — always a word, never a variable */
    quoted(a) {
      this.lit('"');
      const end = this.s.indexOf('"', this.i);
      if (end < 0) this.fail('unclosed quote');
      const text = this.s.slice(this.i, end);
      this.i = end + 1;
      return { t: 'str', v: text, sp: [a, this.i], mods: this.modifiers(), uid: ++this.uid };
    }

    /** `{name}` — always a variable, never a word */
    varRef(a) {
      this.lit('{');
      const m = /^[a-zA-Z_]+/.exec(this.s.slice(this.i));
      if (!m) this.fail('expected a variable name after "{"');
      this.i += m[0].length;
      if (!this.lit('}')) this.fail('expected "}" to close the variable name');
      return {
        t: 'word', name: m[0], forced: true, sp: [a, this.i],
        mods: this.modifiers(), uid: ++this.uid
      };
    }

    /** `[a,b,c]` — a custom die: one face is picked, then evaluated */
    custom(a) {
      const oA = this.mark();
      this.lit('[');
      const { items, commas } = this.list();
      const cA = this.mark();
      if (!this.lit(']')) this.fail('expected "]" to close the custom die');
      return {
        t: 'custom', items, commas, brk: [[oA, oA + 1], [cA, cA + 1]],
        mods: this.modifiers(), core: [a, cA + 1], sp: [a, this.i], uid: ++this.uid
      };
    }

    /** `( a , b )` with an optional repeat count in front */
    bracket(a, count) {
      const oA = this.mark();
      this.lit('(');
      const openSp = [oA, this.i];
      const { items, commas } = this.list();
      const cA = this.mark();
      if (!this.lit(')')) this.fail('expected ")"');
      const brk = [openSp, [cA, this.i]];
      const closeEnd = this.i;

      // `(2+2)d6` — the bracket is a dice quantity, not a set
      if (!count && items.length === 1 && this.atDice()) {
        return this.dice({ t: 'paren', v: items[0], brk, sp: [a, closeEnd] }, a);
      }
      const mods = this.modifiers();
      const uid = ++this.uid;
      const base = { items, commas, mods, brk, core: [a, closeEnd], sp: [a, this.i], uid };
      if (count) return Object.assign({ t: 'rep', count }, base);
      if (items.length > 1) return Object.assign({ t: 'set' }, base);
      return { t: 'paren', v: items[0], mods, brk, core: [a, closeEnd], sp: [a, this.i], uid };
    }

    dice(qty, a) {
      this.lit('d');
      let sides;
      this.ws();
      const sA = this.i;
      if (this.lit('(')) {
        sides = this.expr();
        if (!this.lit(')')) this.fail('expected ")" after computed sides');
      } else {
        const v = this.number();
        if (v === null) this.fail('expected the number of sides after "d"');
        sides = { t: 'num', v, sp: [sA, this.i] };
      }
      const coreEnd = this.i;
      const mods = this.modifiers();
      return { t: 'dice', qty, sides, mods, core: [a, coreEnd], sp: [a, this.i], uid: ++this.uid };
    }

    /* ------------------------------------------------------- comparisons */
    comparePoint() {
      this.ws();
      for (const op of ['<=', '>=', '!=', '<>', '=', '<', '>']) {
        if (this.s.substr(this.i, op.length) !== op) continue;
        const save = this.i;
        const name = op === '<>' ? '!=' : op;
        this.i += op.length;
        const v = this.signedInt();
        if (v !== null) return { op: name, v };
        // not a plain number, so the other side is an expression of its own
        try { return { op: name, node: this.primary() }; }
        catch (e) { this.i = save; return null; }
      }
      return null;
    }

    /** an explicit comparison, or a bare number in the modifier's direction */
    cpDir(dir) {
      const cp = this.comparePoint();
      if (cp) return cp;
      const n = this.digits();
      return n === null ? null : { op: dir, v: n };
    }

    modifiers() {
      const mods = [];
      for (;;) {
        const m = this.modifier();
        if (!m) return mods;
        if (m.t === 'explode' && mods.some((p) => p.t === 'explode')) {
          this.fail('a die can only explode once');
        }
        if (mods.some((p) => p.t === 'adv')) {
          // anything after it would apply to each attempt, not to the winner
          this.fail('advantage rolls everything to its left, so it has to come last — ' +
            'bracket it to carry on, like (2d6a)>=9');
        }
        if (m.t === 'adv') {
          if (!(m.n >= 1)) this.fail('advantage needs at least one roll');
          if (m.n > LIMIT.repeat) this.fail('too many rolls (max ' + LIMIT.repeat + ')');
        }
        mods.push(m);
      }
    }

    fin(start, m) { m.sp = [start, this.i]; return m; }

    modifier() {
      const start = this.mark();
      const back = () => { this.i = start; return null; };

      if (this.lit('min')) {
        const n = this.signedInt();
        return n === null ? back() : this.fin(start, { t: 'min', n });
      }
      if (this.lit('max')) {
        const n = this.signedInt();
        return n === null ? back() : this.fin(start, { t: 'max', n });
      }

      /* repeatable things: bare letter once, trailing i for as long as it holds */
      if (this.lit('epi')) return this.fin(start, { t: 'explode', pen: true, inf: true, cp: this.cpDir('>=') });
      if (this.lit('ep')) return this.fin(start, { t: 'explode', pen: true, inf: false, cp: this.cpDir('>=') });
      if (this.lit('ei')) return this.fin(start, { t: 'explode', pen: false, inf: true, cp: this.cpDir('>=') });
      if (this.lit('e')) return this.fin(start, { t: 'explode', pen: false, inf: false, cp: this.cpDir('>=') });
      if (this.lit('ri')) return this.fin(start, { t: 'reroll', inf: true, cp: this.cpDir('<=') });
      if (this.lit('r')) return this.fin(start, { t: 'reroll', inf: false, cp: this.cpDir('<=') });

      if (this.lit('u')) {
        const cp = this.comparePoint();
        const tries = cp ? 0 : (this.digits() || 0);
        return this.fin(start, { t: 'unique', tries, cp });
      }

      /* `da` has to be tried before the `d` that starts dh/dl/drop, which would
         otherwise match its first letter and give up on the whole modifier */
      if (this.lit('da')) return this.fin(start, { t: 'adv', end: 'l', n: this.digits() ?? 2 });
      if (this.lit('a')) return this.fin(start, { t: 'adv', end: 'h', n: this.digits() ?? 2 });

      if (this.lit('kh')) return this.fin(start, { t: 'keep', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('kl')) return this.fin(start, { t: 'keep', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('dh')) return this.fin(start, { t: 'drop', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('dl')) return this.fin(start, { t: 'drop', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('d')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'drop', end: 'l', n });
      }

      /* checks. `s` may be left out: 3d6>=5 is 3d6s>=5 */
      if (this.lit('cs')) {
        const cp = this.cpDir('>=');
        return cp ? this.fin(start, { t: 'check', check: 'cs', cp }) : back();
      }
      if (this.lit('cf')) {
        const cp = this.cpDir('<=');
        return cp ? this.fin(start, { t: 'check', check: 'cf', cp }) : back();
      }
      if (this.lit('s')) {
        const cp = this.cpDir('>=');
        return cp ? this.fin(start, { t: 'check', check: 's', cp }) : back();
      }
      if (this.lit('f')) {
        const cp = this.cpDir('<=');
        return cp ? this.fin(start, { t: 'check', check: 'f', cp }) : back();
      }
      const bare = this.comparePoint();
      if (bare) return this.fin(start, { t: 'check', check: 's', cp: bare, bare: true });

      return back();
    }
  }

  /* ==========================================================================
     STATIC CHECKS — everything that can be rejected before rolling
     ========================================================================== */
  function isSet(node) {
    switch (node.t) {
      case 'dice': return node.qty !== null;
      case 'rep': return true;
      case 'set': return true;
      case 'paren': return isSet(node.v);   // brackets only group; they do not build a set
      default: return false;
    }
  }

  function checkOf(node) {
    const c = (node.mods || []).filter((m) => m.t === 'check').pop();
    return c ? c.check : null;
  }

  /* Could this ever read as a yes-or-no? A check says so outright; a word might
     be one, or name a variable that is. Anything else is a number, and saying so
     before the roll beats a green tick that fails the moment you press Enter. */
  function canBeCondition(node) {
    if (!node || typeof node !== 'object') return false;
    if ((node.mods || []).some((m) => m.t === 'check')) return true;
    switch (node.t) {
      case 'word': case 'str': case 'ternary': return true;
      case 'paren': case 'neg': return canBeCondition(node.v);
      case 'set': case 'rep': case 'custom': return node.items.some(canBeCondition);
    }
    return false;
  }

  function typeCheck(node, arith) {
    const mods = node.mods || [];

    for (const m of mods) {
      const spec = MODS[m.t === 'check' ? 'check' : m.t];
      if (!spec) continue;
      if (spec.kind === 'set' && !isSet(node)) {
        throw new DiceError('"' + modText(m) + '" needs a set of values — give it a count ' +
          'like 4d6, or list them like (d6,d8)', m.sp && m.sp[0]);
      }
      if ((spec.kind === 'die' || spec.dice) && node.t !== 'dice') {
        throw new DiceError('"' + modText(m) + '" has to attach to dice — there is nothing to re-roll',
          m.sp && m.sp[0]);
      }
      // advantage sums each attempt before comparing, so it needs a number
      if (m.t === 'adv') {
        const c = checkOf(node);
        if (c && !CHECKS[c].castable) {
          throw new DiceError('advantage compares sums, and a ' + CHECKS[c].label.toLowerCase() +
            ' carries no number', m.sp && m.sp[0]);
        }
      }
      if (m.cp && m.cp.node) {
        if (isSet(m.cp.node)) {
          throw new DiceError('the other side of a comparison has to be a single value, ' +
            'not a set', m.cp.node.sp && m.cp.node.sp[0]);
        }
        typeCheck(m.cp.node, false);
      }
    }

    const chk = checkOf(node);
    if (chk && !CHECKS[chk].castable && arith) {
      const m = mods.filter((x) => x.t === 'check').pop();
      throw new DiceError('a ' + CHECKS[chk].label.toLowerCase() + ' carries no number, ' +
        'so it cannot be used in a calculation', m && m.sp && m.sp[0]);
    }

    switch (node.t) {
      case 'bin': typeCheck(node.l, true); typeCheck(node.r, true); break;
      case 'neg': typeCheck(node.v, arith); break;
      case 'paren': typeCheck(node.v, arith); break;
      case 'set': case 'rep': case 'custom': node.items.forEach((i) => typeCheck(i, false)); break;
      case 'band':
        typeCheck(node.subject, false);
        for (const a of node.arms) {
          if (a.cp.node) {
            if (isSet(a.cp.node)) {
              throw new DiceError('the other side of a comparison has to be a single value, ' +
                'not a set', a.cp.node.sp && a.cp.node.sp[0]);
            }
            typeCheck(a.cp.node, false);
          }
          typeCheck(a.then, arith);
        }
        typeCheck(node.otherwise, arith);
        break;
      case 'ternary':
        if (!canBeCondition(node.cond)) {
          throw new DiceError('a ? : choice needs something that reads success or failure on ' +
            'the left — compare something first, like d20>=15 ? hit : miss',
            node.qSp && node.qSp[0]);
        }
        typeCheck(node.cond, false); typeCheck(node.yes, arith); typeCheck(node.no, arith); break;
      case 'func': node.args.forEach((a) => typeCheck(a, true)); break;
      case 'dice':
        if (node.qty) typeCheck(node.qty, true);
        typeCheck(node.sides, true);
        break;
    }
    return node;
  }

  /* ==========================================================================
     VALUES
     ========================================================================== */
  /** the value being compared against, rolled once for this one comparison */
  function cpEval(cp, ctx) {
    if (!cp.node) return { v: cp.v, node: null };
    const r = evalNode(cp.node, ctx || { dice: 0, depth: 0, vars: null });
    if (r.set) throw new DiceError('the other side of a comparison has to be a single value');
    return { v: (r.word !== undefined && r.word !== null) ? r.word : r.total(), node: r };
  }

  function compare(op, a, b) {
    switch (op) {
      case '=': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
    }
    return false;
  }

  const cpTest = (cp, val, ctx) => compare(cp.op, val, cpEval(cp, ctx).v);

  /* Written out, a comparison should read as something that is true. When the
     check missed, the statement that held is the opposite one. */
  /* written as entities: these go straight into markup, and a bare < would eat it */
  const CMP_SYM = { '=': '=', '!=': '≠', '<': '&lt;', '>': '&gt;', '<=': '≤', '>=': '≥' };
  const CMP_NEG = { '=': '!=', '!=': '=', '<': '>=', '>': '<=', '<=': '>', '>=': '<' };

  function sideHTML(side) {
    if (side.node) return side.node.html();
    return typeof side.v === 'string'
      ? '<span class="r-str">' + esc(side.v) + '</span>'
      : '<span class="r-num">' + fmt(side.v) + '</span>';
  }

  /** a value, and the comparison that decided it, for a choice to point at */
  function condHTML(cv) {
    const c = cv.check;
    if (!c || !c.op) return cv.html();
    const op = c.hit ? c.op : CMP_NEG[c.op];
    let out = cv.html() + '<span class="r-cmp">' + CMP_SYM[op] + '</span>' + sideHTML(c.rhs);
    /* In a chain the arm that held says only half of it. Naming the arm that
       failed just before gives the band both its edges. */
    if (c.also) {
      out += '<span class="r-kw">and</span>' +
        '<span class="r-cmp">' + CMP_SYM[c.also.op] + '</span>' + sideHTML(c.also.rhs);
    }
    return out;
  }

  const SOLIDS = {
    2: 'd2', 3: 'd6', 4: 'd4', 5: 'd5', 6: 'd6', 7: 'd7', 8: 'd8', 9: 'd9',
    10: 'd10', 11: 'd11', 12: 'd12', 14: 'd14', 16: 'd16', 18: 'd18',
    20: 'd20', 100: 'd100'
  };
  const shapeFor = (sides) => SOLIDS[sides] || (sides > 20 ? 'd100' : 'd20');

  const SQUEEZE_AT = 3;
  const squeezeStyle = (n) => n <= SQUEEZE_AT ? ''
    : ' style="--sq:' + ((SQUEEZE_AT - n) / (n - 1)).toFixed(4) + '"';
  const PLUS = '<span class="r-plus">+</span>';

  /* Every check yields a word. Only the success check carries a number
     through to arithmetic; the other three are terminal result types. */
  function wordOf(item) {
    if (!item.check) return item.word || null;
    return checkWord(item.check);
  }

  function checkTotal(item) {
    const c = item.check;
    if (!c) return null;
    if (!CHECKS[c.kind].castable) {
      throw new DiceError('a ' + CHECKS[c.kind].label.toLowerCase() + ' cannot be used as a number');
    }
    return c.hit ? 1 : 0;
  }

  /** the result class this value carries in its own right, or '' */
  function markOf(item) {
    if (!item.check) return '';
    return checkWord(item.check) || '';
  }
  const markClass = (item) => { const m = markOf(item); return m ? ' ' + m : ''; };

  /** totals throw on a non-castable check; the display must not. raw() is the
      underlying number, which never consults the check, so there is no loop. */
  function safeTotal(node) {
    try { return node.total(); } catch (e) { return node.raw(); }
  }

  /* Dropped and result state travel down the render, so the dice under a
     discarded group are struck out and the ones under a check are coloured.
     A value with a check of its own replaces what it inherited — the closest
     check always wins. */
  function ctxFor(o, item) {
    const own = markOf(item);
    const mark = own || (o && o.mark) || '';
    const dropped = !!(o && o.dropped) || !!item.dropped;
    if (mark === ((o && o.mark) || '') && dropped === !!(o && o.dropped)) return o;
    return { plain: !!(o && o.plain), mark, dropped };
  }
  const inheritClass = (o, item) => {
    const own = markClass(item);
    if (own) return own;
    return (o && o.mark) ? ' ' + o.mark : '';
  };
  const isDropped = (o, item) => !!item.dropped || !!(o && o.dropped);

  /* A short phrase per modifier, for the subtotal bracket. The verb and the
     count come first so that a cropped bracket still reads "kept" or "kept 5" —
     which end it was is the least of the three worth keeping. */
  const cpShort = (cp) => {
    if (!cp) return '';
    const v = cpSrc(cp);
    if (cp.op === '>=') return v + '+';
    if (cp.op === '<=') return '≤' + v;
    if (cp.op === '!=') return '≠' + v;
    return cp.op + v;
  };
  const CHECK_SHORT = { s: 'success', f: 'failure', cs: 'crit', cf: 'crit fail' };

  function modNote(m, future) {
    const end = (e) => e === 'h' ? 'highest' : 'lowest';
    const w = (now, then) => future ? now : then;
    switch (m.t) {
      case 'min': return w('floor at ', 'floored at ') + m.n;
      case 'max': return w('cap at ', 'capped at ') + m.n;
      case 'explode': return (m.pen ? w('penetrate', 'penetrated') : w('explode', 'exploded')) +
        (m.inf ? ' repeatedly' : '');
      case 'reroll': return w('re-roll', 're-rolled') + (m.inf ? ' repeatedly' : '');
      case 'unique': return w('make unique', 'made unique');
      case 'keep': return w('keep ', 'kept ') + m.n + ' ' + end(m.end);
      case 'drop': return w('drop ', 'dropped ') + m.n + ' ' + end(m.end);
      case 'check': return CHECK_SHORT[m.check] + ' on ' + cpShort(m.cp);
      case 'adv': {
        const best = m.end === 'h';
        if (m.n === 2) return best ? 'advantage' : 'disadvantage';
        return (best ? 'best of ' : 'worst of ') + m.n;
      }
    }
    return '';
  }

  /** every modifier on a node, in the order they are applied */
  function noteList(mods, future) {
    if (!mods || !mods.length) return [];
    const rank = (m) => { const k = MODS[m.t === 'check' ? 'check' : m.t]; return k ? k.order : 99; };
    // the preview writes comparisons out in full, so they are not steps there
    return mods.filter((m) => !(future && m.t === 'check'))
      .sort((a, b) => rank(a) - rank(b))
      .map((m) => modNote(m, future)).filter(Boolean);
  }

  /* Two kinds of label hang off a subtotal: a descriptor, which names what the
     value is (a variable) and rides along with the number, and a step, which
     replaces the number with the modifier it stands for. */
  const noteAttr = (name, list) =>
    list.length ? ' ' + name + '="' + esc(list.join('|')) + '"' : '';

  /** what the subtotal bracket needs to know beyond its number */
  function stateAttr(o, item) {
    const mark = markOf(item);
    return (isDropped(o, item) ? ' data-drop="1"' : '') +
      (mark ? ' data-mark="' + mark + '"' : '') +
      noteAttr('data-note', item.note ? [item.note] : []) +
      noteAttr('data-steps', noteList(item.mods, false));
  }

  /* --------------------------------------------------------------- values
     Every rolled thing answers the same questions, so they share one
     prototype and each kind supplies only what differs:

       raw()    the number underneath, never consulting the check
       total()  the number it counts as, which a check can replace
       value    what a comparison sees: a word if it has one, else raw()
       cond()   true, false, or null when it is not a yes-or-no at all
       html(o)  markup, with `o` carrying state inherited from above

     raw() exists because total() can throw and the display must not: a
     terminal result type has no number, yet still has to be drawn. */
  const VALUE = {
    set: false, die: false, atom: false, custom: false,
    check: null, dropped: false, note: null, uid: 0, mods: null,
    raw() { return 0; },
    total() { const c = checkTotal(this); return c === null ? this.raw() : c; },
    cond() {
      if (this.check) return this.check.hit;
      return this.inner ? this.inner.cond() : null;
    },
    get value() {
      const w = this.word;
      return (w === undefined || w === null) ? this.raw() : w;
    },
    /* a word belongs to whatever is innermost, so a wrapper reports its own */
    get word() { return this.inner ? this.inner.word : this._word; },
    set word(w) { this._word = w; },
    html() { return ''; }
  };
  const value = (spec) => Object.assign(Object.create(VALUE), spec);

  /** the classes a value wears once state from above is folded in */
  const stateCls = (o, item) => inheritClass(o, item) + (isDropped(o, item) ? ' dropped' : '');

  function Die(roll, sides, uid) {
    return value({
      die: true, atom: true, roll, sides, uid,
      raw() { return roll.v; },
      html(o) {
        const tag = uid ? ' data-x="d' + uid + '"' : '';
        return (o && o.plain) ? chipHTML(this, tag, o) : dieHTML(this, shapeFor(sides), tag, o);
      }
    });
  }

  /** a word: 'success', 'failure', or anything the user wrote */
  function Str(word) {
    return value({
      atom: true, word,
      total() {
        throw new DiceError('"' + word + '" is a word, not a number, ' +
          'so it cannot be used in a calculation');
      },
      cond() {
        if (this.check) return this.check.hit;
        if (word === 'success') return true;
        if (word === 'failure') return false;
        return null;
      },
      html(o) {
        return '<span class="r-str' + stateCls(o, this) + '">' + esc(word) + '</span>';
      }
    });
  }

  function Val(v) {
    return value({
      atom: true,
      raw() { return v; },
      html(o) {
        return '<span class="r-num' + stateCls(o, this) + '">' + fmt(v) + '</span>';
      }
    });
  }

  /* A worked-out expression — a sum, a negation, a function call. It keeps its
     parts rather than a baked string, so state reaching it later (a discard, a
     check, the plain-chip fallback) still travels down to the dice inside. */
  function Expr(v, parts) {
    return value({
      parts,
      raw() { return v; },
      html(o) {
        const co = ctxFor(o, this);
        return parts.map((p) => typeof p === 'string' ? p : p.html(co)).join('');
      }
    });
  }

  /** a bracket around a value: still a value, drawn with its own subtotal */
  function Group(inner, uid, opts) {
    opts = opts || {};
    return value({
      uid, inner, condVal: opts.condVal || null, note: opts.note || null,
      raw() { return inner.raw(); },
      total() { const c = checkTotal(this); return c === null ? inner.total() : c; },
      html(o) {
        const tag = uid ? ' data-x="' + (opts.tag || 's') + uid + '"' : '';
        // a word has no subtotal to draw a bracket for
        const sum = inner.word !== undefined ? ''
          : ' data-sum="' + esc(fmt(safeTotal(inner))) + '"' + stateAttr(o, this);
        const co = ctxFor(o, this);
        const open = opts.bare ? '' : '<span class="r-brk"' + tag + '>(</span>';
        const close = opts.bare ? '' : '<span class="r-brk"' + tag + '>)</span>';
        return '<span class="r-grp"' + tag + sum + '>' + (opts.prefix || '') +
          open + inner.html(co) + close + '</span>';
      }
    });
  }

  /* A mention of a roll binding after the first. Drawing the same dice again
     would say they were thrown again, so it shows the name and what it came to.
     It holds no `inner`, which keeps the dice from being counted twice. */
  function Ref(inner, name, uid) {
    return value({
      uid, word: inner.word,
      raw() { return inner.raw(); },
      total() { const c = checkTotal(this); return c === null ? inner.total() : c; },
      cond() { return this.check ? this.check.hit : inner.cond(); },
      html(o) {
        const tag = uid ? ' data-x="w' + uid + '"' : '';
        const w = inner.word;
        const shown = (w === undefined || w === null) ? fmt(safeTotal(inner)) : String(w);
        return '<span class="r-ref' + stateCls(o, this) + '"' + tag + '>' +
          '<i>' + esc(name) + '</i>' + esc(shown) + '</span>';
      }
    });
  }

  /** a face picked off a custom die */
  function CustomDie(inner, shape, uid) {
    return value({
      custom: true, atom: true, uid, inner,
      raw() { return inner.raw(); },
      total() { const c = checkTotal(this); return c === null ? inner.total() : c; },
      html(o) {
        const tag = uid ? ' data-x="c' + uid + '"' : '';
        const w = wordOf(this);
        const face = (w === null || w === undefined)
          ? (inner.word !== undefined ? inner.word : fmt(safeTotal(inner))) : w;
        const mk = inheritClass(o, this);
        /* A word does not sit on a face legibly, and the shape it was drawn from
           says nothing once it has been drawn. Write it out instead. */
        if (typeof face === 'string' && !/^-?\d+(\.\d+)?$/.test(face)) {
          return '<span class="r-pick' + stateCls(o, this) + '"' + tag +
            ' title="custom die">' + esc(face) + '</span>';
        }
        const cls = ['die', 'custom', 's-' + shape];
        if (mk) cls.push(mk.trim());
        if (isDropped(o, this)) cls.push('dropped');
        const len = String(face).length;
        const size = len >= 5 ? ' v5' : (len >= 4 ? ' v4' : (len === 3 ? ' v3' : (len === 2 ? ' v2' : '')));
        return '<span class="' + cls.join(' ') + '"' + tag + ' title="custom die">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
          '<use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval' + size + '">' + esc(String(face)) + '</span></span>';
      }
    });
  }

  /* ------------------------------------------------------------ variables */
  let VARS = {};
  const varCache = new Map();

  function varAst(name, src) {
    const key = name + '::' + src;
    if (!varCache.has(key)) varCache.set(key, new Parser(splitLabel(src).body).parse());
    return varCache.get(key);
  }

  /* An `a:=expr` written into the expression itself only lives for that one
     expression, and shadows a variable of the same name from the panel. */
  const varSrc = (name, ctx) =>
    (ctx && ctx.vars && ctx.vars[name] !== undefined) ? ctx.vars[name] : VARS[name];

  function setVars(map) {
    VARS = {};
    for (const k in map) if (/^[a-zA-Z_]+$/.test(k)) VARS[k] = map[k];
    varCache.clear();
  }

  /* A choice needs one yes-or-no. A checked value gives it straight away; a set
     of them reads yes when any member hit, so `4d20>10 ? a : b` is "if any of
     the four beat 10". Something carrying no check at all is not a condition. */
  function truth(v) {
    const c = v.cond ? v.cond() : null;
    if (c === null || c === undefined) {
      throw new DiceError('a ? : choice needs something that reads success or failure on ' +
        'the left — compare something first, like d20>=15 ? hit : miss');
    }
    return c;
  }

  /** tally the result types in a value. the closest check speaks for what is under it */
  function collectMarks(v, out) {
    if (!v || v.dropped) return;
    if (v.check) {
      const w = checkWord(v.check);
      if (w) out[w] = (out[w] || 0) + 1;
      return;
    }
    if (v.set) { for (const m of v.members) collectMarks(m, out); return; }
    if (v.inner) { collectMarks(v.inner, out); return; }
    if (v.parts) { for (const p of v.parts) if (typeof p !== 'string') collectMarks(p, out); }
  }

  function SetVal(members, opts) {
    opts = opts || {};
    return value({
      set: true, members, uid: opts.uid,
      brackets: !!opts.brackets, prefix: opts.prefix || '', note: opts.note || null,
      raw() { let s = 0; for (const m of members) if (!m.dropped) s += m.raw(); return s; },
      live() { return members.filter((m) => !m.dropped); },
      total() {
        const c = checkTotal(this);
        if (c !== null) return c;
        let s = 0;
        for (const m of this.live()) s += m.total();
        return s;
      },
      cond() {
        if (this.check) return this.check.hit;
        let seen = null;
        for (const m of this.live()) {
          const c = m.cond ? m.cond() : null;
          if (c === null || c === undefined) continue;
          if (c) return true;
          seen = false;
        }
        return seen;
      },
      /* a set of words has no sum worth showing, so it shows what it holds */
      sumText() {
        const live = this.live();
        const worded = (m) => (m.word !== undefined && m.word !== null);
        if (!live.some(worded)) return fmt(safeTotal(this));
        return live.map((m) => worded(m) ? String(m.word) : fmt(safeTotal(m))).join(', ');
      },
      html(o) {
        const tag = this.uid ? ' data-x="' + (opts.tag || (this.brackets ? 's' : 'd')) + this.uid + '"' : '';
        const sum = ' data-sum="' + esc(this.sumText()) + '"' + stateAttr(o, this);
        const co = ctxFor(o, this);
        if (this.brackets) {
          return '<span class="r-grp"' + tag + sum + '>' + this.prefix +
            '<span class="r-brk"' + tag + '>(</span>' +
            members.map((m) => m.html(co)).join('<span class="r-op">,</span>') +
            '<span class="r-brk"' + tag + '>)</span></span>';
        }
        const squeezed = members.length > SQUEEZE_AT && members.every((m) => m.die);
        const body = members.map((m) => m.html(co)).join(squeezed ? '' : PLUS);
        return '<span class="r-term' + (squeezed ? ' squeezed' : '') + '"' + tag +
          (members.length > 1 ? sum : '') + squeezeStyle(members.length) + '>' + body + '</span>';
      }
    });
  }

  /* ------------------------------------------------------------- markup */
  function dieHTML(item, shape, tag, o) {
    const r = item.roll;
    const cls = ['die', 's-' + shape].concat(r.tags);
    if (isDropped(o, item)) cls.push('dropped');
    const mk = inheritClass(o, item);
    if (mk) cls.push(mk.trim());
    const face = fmt(r.v);
    const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');
    let badge = '';
    if (r.from !== null && r.from !== undefined) badge = '<s>' + esc(fmt(r.from)) + '</s>';
    else if (r.tags.indexOf('exploded') >= 0) badge = '!';
    const title = (r.tags.length ? r.tags.join(', ') : 'natural') +
      (isDropped(o, item) ? ', dropped' : '') + (mk ? ',' + mk : '');
    return '<span class="' + cls.join(' ') + '"' + tag + ' title="' + esc(title) + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + esc(face) + '</span>' +
      (badge ? '<span class="diebadge">' + badge + '</span>' : '') + '</span>';
  }

  function chipHTML(item, tag, o) {
    const r = item.roll;
    const cls = ['chip-die'].concat(r.tags);
    if (isDropped(o, item)) cls.push('dropped');
    const mk = inheritClass(o, item);
    if (mk) cls.push(mk.trim());
    const was = (r.from !== null && r.from !== undefined) ? '<s>' + esc(fmt(r.from)) + '</s>' : '';
    const bang = r.tags.indexOf('exploded') >= 0 ? '<sup>!</sup>' : '';
    return '<span class="' + cls.join(' ') + '"' + tag + '>' + was + esc(fmt(r.v)) + bang + '</span>';
  }

  /* ==========================================================================
     EVALUATION
     ========================================================================== */
  const makeDie = (sides) => rng.int(1, sides);
  const num = (node, ctx) => evalNode(node, ctx).total();

  function applyDieMods(rolls, sides, mods, ctx) {
    const tag = (r, t) => { if (r.tags.indexOf(t) < 0) r.tags.push(t); };
    let out = rolls;
    const die = mods.filter((x) => MODS[x.t] && MODS[x.t].kind === 'die')
      .sort((a, b) => MODS[a.t].order - MODS[b.t].order);
    for (const m of die) {
      if (m.t === 'explode') {
        const cp = m.cp || { op: '=', v: sides };
        const next = [];
        for (const r of out) {
          next.push(r);
          let last = r.v, n = 0;
          while (cpTest(cp, last, ctx) && n < LIMIT.explode) {
            n++;
            if (++ctx.dice > LIMIT.totalDice) throw new DiceError('too many dice in one expression');
            const raw = makeDie(sides);
            last = raw;
            next.push({ v: m.pen ? raw - 1 : raw, tags: ['exploded'], from: null });
            if (!m.inf) break;
          }
          if (n > 0) tag(r, 'exploded');
        }
        out = next;
      } else if (m.t === 'reroll') {
        const cp = m.cp || { op: '=', v: 1 };
        for (const r of out) {
          let n = 0;
          while (cpTest(cp, r.v, ctx) && n < LIMIT.reroll) {
            if (r.from === null) r.from = r.v;
            r.v = makeDie(sides);
            tag(r, 'rerolled');
            n++;
            if (!m.inf) break;
          }
        }
      }
    }
    return out;
  }

  /* a member already thrown away takes no further part */
  function eachMember(value, fn) {
    if (value.set) { for (const m of value.members) if (!m.dropped) fn(m); }
    else fn(value);
  }

  function applyElement(item, m, ctx) {
    if (m.t === 'min' || m.t === 'max') {
      if (!item.roll) return;                       // clamping only means something on a face
      const over = m.t === 'min' ? item.roll.v < m.n : item.roll.v > m.n;
      if (!over) return;
      if (item.roll.from === null) item.roll.from = item.roll.v;
      item.roll.v = m.n;
      if (item.roll.tags.indexOf('clamped') < 0) item.roll.tags.push('clamped');
      return;
    }
    if (m.t === 'check') {
      // the other side is kept, not just its verdict: a choice shows its reason
      const rhs = cpEval(m.cp, ctx);
      item.check = {
        kind: m.check, hit: compare(m.cp.op, item.value, rhs.v),
        bare: !!m.bare, op: m.cp.op, rhs
      };
    }
  }

  function applySet(value, m, sides, ctx) {
    if (!value.set) throw new DiceError('"' + modText(m) + '" needs a set of values');
    const members = value.members;
    if (m.t === 'keep' || m.t === 'drop') {
      const live = members.filter((x) => !x.dropped);
      const order = live.slice().sort((a, b) => safeTotal(b) - safeTotal(a));
      if (m.t === 'keep') {
        const keep = new Set(m.end === 'l' ? order.slice(-m.n) : order.slice(0, m.n));
        for (const x of live) if (!keep.has(x)) x.dropped = true;
      } else {
        for (const x of (m.end === 'h' ? order.slice(0, m.n) : order.slice(-m.n))) x.dropped = true;
      }
      return;
    }
    if (m.t === 'unique') {
      const seen = new Set();
      const cap = m.tries || LIMIT.reroll;
      for (const x of members) {
        if (!x.die) throw new DiceError('"u" needs dice to re-roll');
        let n = 0;
        while (seen.has(x.roll.v) && (!m.cp || cpTest(m.cp, x.roll.v, ctx)) && n < cap) {
          if (x.roll.from === null) x.roll.from = x.roll.v;
          x.roll.v = makeDie(sides);
          if (x.roll.tags.indexOf('rerolled') < 0) x.roll.tags.push('rerolled');
          n++;
        }
        seen.add(x.roll.v);
      }
    }
  }

  function applyMods(value, mods, sides, ctx) {
    if (mods && mods.length) value.mods = mods;   // the subtotal bracket names them
    const ordered = mods.filter((m) => {
      const k = MODS[m.t === 'check' ? 'check' : m.t];
      return k && k.kind !== 'die';
    }).sort((a, b) => {
      const ka = MODS[a.t === 'check' ? 'check' : a.t];
      const kb = MODS[b.t === 'check' ? 'check' : b.t];
      return ka.order - kb.order;
    });

    for (const m of ordered) {
      const kind = MODS[m.t === 'check' ? 'check' : m.t].kind;
      if (kind === 'element') eachMember(value, (item) => applyElement(item, m, ctx));
      else applySet(value, m, sides, ctx);
    }
    return value;
  }

  function rollDice(node, ctx) {
    const sides = Math.floor(num(node.sides, ctx));
    if (!(sides >= 1)) throw new DiceError('a die needs at least 1 side (got ' + sides + ')');
    if (sides > LIMIT.sides) throw new DiceError('too many sides (max ' + LIMIT.sides + ')');

    const single = node.qty === null;
    const qty = single ? 1 : Math.floor(num(node.qty, ctx));
    if (!(qty >= 0)) throw new DiceError('dice quantity must be 0 or more (got ' + qty + ')');
    if (qty > LIMIT.qty) throw new DiceError('too many dice (max ' + LIMIT.qty + ')');
    ctx.dice += qty;
    if (ctx.dice > LIMIT.totalDice) throw new DiceError('too many dice in one expression');

    let rolls = [];
    for (let i = 0; i < qty; i++) rolls.push({ v: makeDie(sides), tags: [], from: null });
    rolls = applyDieMods(rolls, sides, node.mods, ctx);

    const uid = uidOf(node, ctx);
    const dice = rolls.map((r) => Die(r, sides, uid));
    // a bare d6 is one value; 4d6 is a set of four
    const value = single ? dice[0] : SetVal(dice, { uid });
    return applyMods(value, node.mods, sides, ctx);
  }

  /** a set inside a set unpacks, so nesting never compounds */
  function flatten(items) {
    const out = [];
    for (const it of items) {
      if (it.set && !it.brackets) out.push.apply(out, it.members);
      else out.push(it);
    }
    return out;
  }

  /* Advantage rolls the term again rather than reshaping one roll, so it wraps
     evaluation instead of joining the modifier chain. Each attempt keeps its
     own shape but is compared by its sum — that is what makes `2d6a` the better
     of two totals rather than the best of four dice. */
  function rollAdv(node, m, ctx) {
    const once = Object.assign({}, node, { mods: node.mods.filter((x) => x !== m) });
    const tries = [];
    for (let i = 0; i < m.n; i++) tries.push(evalNode(once, ctx));
    const out = SetVal(tries, { uid: uidOf(node, ctx), brackets: tries.length > 1 });
    out.mods = [m];
    applySet(out, { t: 'keep', end: m.end, n: 1 }, null, ctx);
    return out;
  }

  /* A `::=` binding is thrown once and then referred to, which is what lets a
     chain of comparisons ask about the same roll several times. It is a value,
     never a set: it stands for what the roll came to. */
  function fixedValue(node, slot, ctx) {
    if (!slot.v) {
      if (slot.busy) throw new DiceError('"' + node.name + '" is defined in terms of itself');
      slot.busy = true;
      slot.v = evalNode(slot.ast, ctx);
      slot.busy = false;
    }
    const uid = uidOf(node, ctx);
    const wrapped = slot.used
      ? Ref(slot.v, node.name, uid)
      : Group(slot.v, uid, { note: node.name, tag: 'w', bare: !!slot.v.atom });
    slot.used = true;
    return applyMods(wrapped, node.mods || [], null, ctx);
  }

  function evalNode(node, ctx) {
    const adv = (node.mods || []).find((x) => x.t === 'adv');
    if (adv) return rollAdv(node, adv, ctx);

    switch (node.t) {
      case 'num': return Val(node.v);

      case 'str': return applyMods(Str(node.v), node.mods || [], null, ctx);

      /* a bare word is a variable when one is defined, otherwise just a word */
      case 'word': {
        const slot = ctx.fixed && ctx.fixed[node.name];
        if (slot) return fixedValue(node, slot, ctx);
        const src = varSrc(node.name, ctx);
        if (src === undefined) {
          if (node.forced) throw new DiceError('no variable named "' + node.name + '" is set');
          return applyMods(Str(node.name), node.mods || [], null, ctx);
        }
        if (ctx.depth >= LIMIT.varDepth) {
          throw new DiceError('variable "' + node.name + '" keeps referring back to itself');
        }
        let ast;
        try { ast = varAst(node.name, src); }
        catch (e) { throw new DiceError('variable "' + node.name + '": ' + e.message); }
        /* Inside the variable nothing is tagged: its nodes have no place in the
           expression being edited, so linking them there would be a lie. The
           name rides on the subtotal bracket instead of sitting in the dice. */
        const mute = ctx.mute;
        ctx.depth++; ctx.mute = true;
        const v = evalNode(ast, ctx);
        ctx.mute = mute; ctx.depth--;
        const uid = uidOf(node, ctx);
        // brackets are there to show how far the variable reaches; around a
        // single value there is nothing to show, so they are only noise
        const wrapped = v.set
          ? SetVal(v.members, { uid, brackets: true, note: node.name, tag: 'w' })
          : Group(v, uid, { note: node.name, tag: 'w', bare: !!v.atom });
        return applyMods(wrapped, node.mods || [], null, ctx);
      }

      /* one face is picked, then whatever is written on it is evaluated */
      case 'custom': {
        const pick = node.items[rng.int(0, node.items.length - 1)];
        const v = evalNode(pick, ctx);
        const shape = shapeFor(node.items.length);
        return applyMods(CustomDie(v, shape, uidOf(node, ctx)), node.mods || [], null, ctx);
      }

      /* The choice distributes the same way a comparison does: one condition
         per member, one answer per member. `4d20>5?hit:miss` is four choices,
         not one taken on the sum. */
      case 'ternary': {
        const c = evalNode(node.cond, ctx);
        const uid = uidOf(node, ctx);
        const tag = uid ? ' data-x="t' + uid + '"' : '';
        const answer = (cv) => {
          const v = evalNode(truth(cv) ? node.yes : node.no, ctx);
          const pre = '<span class="r-cond"' + tag + '>' + condHTML(cv) +
            '<span class="r-kw"' + tag + '>so</span></span>';
          // the condition is drawn as part of the prefix; keep the value too,
          // or the dice it rolled go missing from the count that sizes them
          return Group(v, uid, { prefix: pre, bare: true, condVal: cv });
        };
        if (!c.set) return answer(c);
        // a member thrown away before the choice keeps its place, struck out
        return SetVal(c.members.map((m) => m.dropped ? m : answer(m)),
          { uid, brackets: c.members.length > 1 });
      }

      /* One subject, tried against each comparison in turn. The subject is
         worked out once, so the arms all talk about the same roll. */
      case 'band': {
        const v = evalNode(node.subject, ctx);
        const uid = uidOf(node, ctx);
        const tag = uid ? ' data-x="b' + uid + '"' : '';
        const answer = (cv) => {
          let taken = null, before = null;
          for (const arm of node.arms) {
            const rhs = cpEval(arm.cp, ctx);
            const hit = compare(arm.cp.op, cv.value, rhs.v);
            // the last comparison tried is the one a miss reads as the opposite of
            cv.check = { kind: arm.check, hit, bare: arm.bare, op: arm.cp.op, rhs };
            // ...and the one before it is the band's other edge
            if (hit && before) {
              cv.check.also = { op: CMP_NEG[before.op], rhs: before.rhs };
            }
            if (hit) { taken = arm; break; }
            before = { op: arm.cp.op, rhs };
          }
          const out = evalNode(taken ? taken.then : node.otherwise, ctx);
          const pre = '<span class="r-cond"' + tag + '>' + condHTML(cv) +
            '<span class="r-kw"' + tag + '>so</span></span>';
          return Group(out, uid, { prefix: pre, bare: true, condVal: cv });
        };
        if (!v.set) return answer(v);
        return SetVal(v.members.map((m) => m.dropped ? m : answer(m)),
          { uid, brackets: v.members.length > 1 });
      }

      case 'neg': {
        const v = evalNode(node.v, ctx);
        const minus = '<span class="r-op">-</span>';
        if (v.set) {
          // a minus in front of a set flips every member
          return SetVal(v.members.map((m) => Expr(-safeTotal(m), [minus, m])), { uid: uidOf(node, ctx) });
        }
        return Expr(-v.total(), [minus, v]);
      }

      case 'bin': {
        const l = evalNode(node.l, ctx), r = evalNode(node.r, ctx);
        const a = l.total(), b = r.total();
        let v;
        switch (node.op) {
          case '+': v = a + b; break;
          case '-': v = a - b; break;
          case '*': v = a * b; break;
          case '/': v = a / b; break;
          case '%': v = a % b; break;
          case '^': v = Math.pow(a, b); break;
        }
        // Infinity and NaN mean nothing as a roll, so they are an error here
        // rather than a total nobody can read
        if (!isFinite(v)) {
          throw new DiceError(b === 0 && (node.op === '/' || node.op === '%')
            ? 'cannot divide by zero'
            : 'that works out to a number too big to use', node.opSp && node.opSp[0]);
        }
        const tag = uidOf(node, ctx) ? ' data-x="o' + node.uid + '"' : '';
        return Expr(v, [l, '<span class="r-op"' + tag + '>' + esc(node.op) + '</span>', r]);
      }

      case 'func': {
        const args = node.args.map((a) => evalNode(a, ctx));
        const v = FUNCS[node.name].apply(null, args.map((p) => p.total()));
        const parts = ['<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>'];
        args.forEach((p, i) => {
          if (i) parts.push('<span class="r-op">,</span>');
          parts.push(p);
        });
        parts.push('<span class="r-brk">)</span>');
        return Expr(v, parts);
      }

      case 'dice': return rollDice(node, ctx);

      case 'paren': {
        const inner = evalNode(node.v, ctx);
        // grouping only — a bracket never turns a value into a set
        const value = inner.set
          ? SetVal(inner.members, { uid: uidOf(node, ctx), brackets: true })
          : Group(inner, uidOf(node, ctx));
        return applyMods(value, node.mods || [], null, ctx);
      }

      case 'set': {
        const parts = node.items.map((i) => evalNode(i, ctx));
        return applyMods(SetVal(flatten(parts), { uid: uidOf(node, ctx), brackets: true }), node.mods || [], null, ctx);
      }

      case 'rep': {
        const n = Math.floor(num(node.count, ctx));
        if (!(n >= 0)) throw new DiceError('a repeat count must be 0 or more');
        if (n > LIMIT.repeat) throw new DiceError('repeat count too large (max ' + LIMIT.repeat + ')');
        const members = [];
        for (let i = 0; i < n; i++) {
          for (const p of flatten(node.items.map((x) => evalNode(x, ctx)))) members.push(p);
        }
        const prefix = '<span class="r-num">' + esc(plain(node.count)) + '</span>';
        return applyMods(SetVal(members, { uid: uidOf(node, ctx), brackets: true, prefix }), node.mods || [], null, ctx);
      }
    }
    throw new DiceError('cannot evaluate "' + node.t + '"');
  }

  /* ------------------------------------------- notation reconstruction */
  function modText(m) {
    switch (m.t) {
      case 'min': return 'min' + m.n;
      case 'max': return 'max' + m.n;
      case 'explode': return 'e' + (m.pen ? 'p' : '') + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'reroll': return 'r' + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'unique': return 'u' + (m.tries || '') + cpText(m.cp);
      case 'keep': return 'k' + m.end + m.n;
      case 'drop': return 'd' + m.end + m.n;
      case 'check': return (m.bare ? '' : m.check) + cpText(m.cp);
      case 'adv': return (m.end === 'h' ? 'a' : 'da') + (m.n === 2 ? '' : m.n);
    }
    return '';
  }

  function plain(node) {
    const mods = (node.mods || []).map(modText).join('');
    switch (node.t) {
      case 'num': return fmt(node.v);
      case 'str': return '"' + node.v + '"' + mods;
      case 'word': return (node.forced ? '{' + node.name + '}' : node.name) + mods;
      case 'custom': return '[' + node.items.map(plain).join(',') + ']' + mods;
      case 'ternary': return plain(node.cond) + '?' + plain(node.yes) + ':' + plain(node.no);
      case 'band': {
        let s = plain(node.subject);
        node.arms.forEach((a, i) => {
          s += (i ? ':' : '') + (a.bare ? '' : a.check) + cpText(a.cp) + '?' + plain(a.then);
        });
        return s + ':' + plain(node.otherwise);
      }
      case 'neg': return '-' + plain(node.v);
      case 'bin': return plain(node.l) + node.op + plain(node.r);
      case 'func': return node.name + '(' + node.args.map(plain).join(',') + ')';
      case 'dice': {
        const q = node.qty === null ? '' : plain(node.qty);
        const s = node.sides.t === 'num' ? plain(node.sides) : '(' + plain(node.sides) + ')';
        return q + 'd' + s + mods;
      }
      case 'paren': return '(' + plain(node.v) + ')' + mods;
      case 'set': return '(' + node.items.map(plain).join(',') + ')' + mods;
      case 'rep': return plain(node.count) + '(' + node.items.map(plain).join(',') + ')' + mods;
    }
    return '?';
  }

  /* ==========================================================================
     EXPLAIN
     ========================================================================== */
  function cpPhrase(cp, fallback) {
    if (!cp) return fallback || '';
    switch (cp.op) {
      case '=': return 'exactly ' + cpSrc(cp);
      case '!=': return 'anything but ' + cpSrc(cp);
      case '<': return 'less than ' + cpSrc(cp);
      case '>': return 'more than ' + cpSrc(cp);
      case '<=': return cpSrc(cp) + ' or less';
      case '>=': return cpSrc(cp) + ' or more';
    }
    return '';
  }

  function modExplain(m) {
    switch (m.t) {
      case 'min': return ['Minimum', 'Any face below ' + m.n + ' counts as ' + m.n + '.'];
      case 'max': return ['Maximum', 'Any face above ' + m.n + ' counts as ' + m.n + '.'];
      case 'explode': return [m.pen ? 'Penetrating explode' : 'Exploding',
        'When a die rolls ' + cpPhrase(m.cp, 'its highest face') + ', roll an extra die and add it' +
        (m.pen ? ', subtracting 1 from every extra roll' : '') + '.' +
        (m.inf ? ' Repeats while it keeps happening.' : ' One extra roll per die.')];
      case 'reroll': return ['Re-roll',
        'Any die showing ' + cpPhrase(m.cp, 'its lowest face') + ' is re-rolled' +
        (m.inf ? ' until it no longer qualifies.' : ' once — the new value stands.')];
      case 'unique': return ['Unique',
        'Duplicates are re-rolled' + (m.tries ? ' up to ' + m.tries + ' times' : '') +
        ' so every die shows a different value. Needs a set.'];
      case 'keep': return ['Keep ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Keep the ' + (m.n === 1 ? '' : m.n + ' ') + (m.end === 'h' ? 'highest' : 'lowest') +
        ' member; the rest are struck out. Needs a set.'];
      case 'drop': return ['Drop ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Throw away the ' + (m.n === 1 ? '' : m.n + ' ') + (m.end === 'h' ? 'highest' : 'lowest') +
        ' member. Needs a set.'];
      case 'adv': {
        const best = m.end === 'h' ? 'best' : 'worst';
        return [m.end === 'h' ? 'Advantage' : 'Disadvantage',
          'Roll everything to the left ' + (m.n === 2 ? 'twice' : m.n + ' times') +
          ' and keep the ' + best + '. Each attempt is summed before they are compared, ' +
          'so this is the ' + best + ' total rather than the ' + best + ' single die.'];
      }
      case 'check': {
        const c = CHECKS[m.check];
        const miss = (m.bare && c.bareMiss) ? c.bareMiss : c.miss;
        return [c.label, 'Mark every member of ' + cpPhrase(m.cp) + ' as ' + c.hit + '. ' +
          (miss ? 'Anything else reads ' + miss + '. '
                : 'It says nothing about the rest — drop the "' + m.check +
                  '" and write the comparison alone for a plain success/failure. ') +
          (c.castable
            ? 'A hit counts as 1 and a miss as 0, so this can still be used in a calculation.'
            : 'This is a result type — it carries no number, so it cannot be used in a calculation.')];
      }
    }
    return ['Modifier', ''];
  }

  const OP_NAMES = {
    '+': ['Add', 'Each side is reduced to a value first — a set is summed.'],
    '-': ['Subtract', 'Each side is reduced to a value first — a set is summed.'],
    '*': ['Multiply', 'A set is summed before multiplying, never multiplied out.'],
    '/': ['Divide', 'Fractions are kept.'],
    '%': ['Remainder', 'The remainder after dividing.'],
    '^': ['Power', 'Raise the left side to the power of the right.']
  };

  function describe(ast, src) {
    const spans = [], rows = [];
    let uid = 0;

    const push = (sp, cls, row, fixedId) => {
      if (!sp) return null;
      const id = row ? (fixedId || 'x' + (++uid)) : (fixedId || null);
      spans.push({ a: sp[0], b: sp[1], cls, id });
      if (row) rows.push(Object.assign({ id, code: src.slice(sp[0], sp[1]) }, row));
      return id;
    };

    const mods = (node, depth) => {
      for (const m of node.mods || []) {
        const [title, desc] = modExplain(m);
        push(m.sp, 't-mod', { title, desc, depth: depth + 1 });
      }
    };

    function walk(node, depth) {
      switch (node.t) {
        case 'num':
          push(node.sp, 't-num', { title: 'Constant', desc: 'The flat value ' + fmt(node.v) + '.', depth });
          break;
        case 'str':
          push(node.sp, 't-str', {
            title: 'Word',
            desc: 'The literal word ' + node.v + '. Words carry no number, so a word can only be a result.',
            depth
          }, 'w' + node.uid);
          mods(node, depth);
          break;
        case 'word':
          push(node.sp, node.forced ? 't-var' : 't-str', {
            title: node.forced ? 'Variable' : 'Word or variable',
            desc: node.forced
              ? 'Always the variable ' + node.name + ', worked out afresh wherever it appears.'
              : 'If a variable named ' + node.name + ' is set it is used here and worked out afresh; ' +
                'otherwise this is just the word ' + node.name + '. Write {' + node.name +
                '} to insist on the variable.',
            depth
          }, 'w' + node.uid);
          mods(node, depth);
          break;
        case 'custom': {
          const cid = 'c' + node.uid;
          push(node.brk[0], 't-brk', {
            title: 'Custom die',
            desc: 'A die with ' + node.items.length + ' faces. One is picked at random, then whatever ' +
              'is written on it is worked out.',
            depth
          }, cid);
          node.items.forEach((it, i) => {
            walk(it, depth + 1);
            if (node.commas[i]) push(node.commas[i], 't-op', null, cid);
          });
          push(node.brk[1], 't-brk', null, cid);
          mods(node, depth);
          break;
        }
        case 'band': {
          const bid = 'b' + node.uid;
          walk(node.subject, depth + 1);
          node.arms.forEach((a, i) => {
            push(a.sp, 't-mod', {
              title: i ? 'Or when' : 'When',
              desc: 'If what came before is ' + cpPhrase(a.cp) + ', the answer is what ' +
                'follows the ?. The comparisons are tried in the order written, on the ' +
                'one result — nothing is rolled again.',
              depth
            }, bid);
            push(a.qSp, 't-op', null, bid);
            walk(a.then, depth + 1);
            push(a.cSp, 't-op', null, bid);
          });
          walk(node.otherwise, depth + 1);
          break;
        }
        case 'ternary': {
          const tid = 't' + node.uid;
          walk(node.cond, depth + 1);
          push(node.qSp, 't-op', {
            title: 'Choice',
            desc: 'If the left side reads success, take what follows the ?; if failure, take what follows the :.',
            depth
          }, tid);
          walk(node.yes, depth + 1);
          push(node.cSp, 't-op', null, tid);
          walk(node.no, depth + 1);
          break;
        }
        case 'neg':
          push(node.opSp, 't-op', { title: 'Negate', desc: 'Flip the sign. Over a set, every member flips.', depth });
          walk(node.v, depth + 1);
          break;
        case 'bin': {
          walk(node.l, depth);
          const [title, desc] = OP_NAMES[node.op] || ['Operator', ''];
          push(node.opSp, 't-op', { title, desc, depth }, node.uid ? 'o' + node.uid : null);
          walk(node.r, depth);
          break;
        }
        case 'func':
          push(node.nameSp, 't-fn', {
            title: node.name + '()', desc: 'Take ' + FUNC_DESC[node.name] + ' of the list.', depth
          });
          push(node.brk[0], 't-brk');
          node.args.forEach((a) => walk(a, depth + 1));
          push(node.brk[1], 't-brk');
          break;
        case 'dice': {
          const many = node.qty !== null;
          const q = many ? plain(node.qty) : '1';
          const sides = node.sides.t === 'num' ? plain(node.sides) : '(' + plain(node.sides) + ')';
          push(node.core, 't-dice', {
            title: many ? 'Dice — a set' : 'One die — a value',
            desc: many
              ? 'Roll ' + q + ' ' + sides + '-sided dice. That is a set of ' + q +
                ' values, summed whenever a single value is needed.'
              : 'Roll one ' + sides + '-sided die. A single value, not a set — ' +
                'set modifiers like kh will not attach to it.',
            depth
          }, 'd' + node.uid);
          if (node.qty && node.qty.t !== 'num') walk(node.qty, depth + 1);
          if (node.sides.t !== 'num') walk(node.sides, depth + 1);
          mods(node, depth);
          break;
        }
        case 'paren': {
          const pid = 's' + node.uid;
          push(node.brk[0], 't-brk', {
            title: 'Bracket', desc: 'Worked out first. Modifiers after it act on what is inside.', depth
          }, pid);
          walk(node.v, depth + 1);
          push(node.brk[1], 't-brk', null, pid);
          mods(node, depth);
          break;
        }
        case 'set': {
          const sid = 's' + node.uid;
          push(node.brk[0], 't-brk', {
            title: 'Set', desc: 'A set of ' + node.items.length + ' values. Any set inside unpacks ' +
              'into it, and the whole thing sums when a value is needed.', depth
          }, sid);
          node.items.forEach((it, i) => {
            walk(it, depth + 1);
            if (node.commas[i]) push(node.commas[i], 't-op', null, sid);
          });
          push(node.brk[1], 't-brk', null, sid);
          mods(node, depth);
          break;
        }
        case 'rep': {
          const rid = 's' + node.uid;
          push(node.count.sp, 't-rep', {
            title: 'Repeat into a set',
            desc: 'Evaluate the bracket ' + plain(node.count) +
              ' separate times and collect the results as a set.',
            depth
          }, rid);
          // both halves of the pair are painted the same, like every other bracket
          push(node.brk[0], 't-brk', null, rid);
          node.items.forEach((it, i) => {
            walk(it, depth + 1);
            if (node.commas[i]) push(node.commas[i], 't-op', null, rid);
          });
          push(node.brk[1], 't-brk', null, rid);
          mods(node, depth);
          break;
        }
      }
    }

    walk(ast, 0);
    spans.sort((x, y) => x.a - y.a || x.b - y.b);
    return { spans, rows };
  }

  /* ==========================================================================
     PREVIEW — the dice an expression would throw, by name
     ========================================================================== */
  const PREVIEW_MAX = 8;

  function constOf(node) {
    if (!node) return null;
    switch (node.t) {
      case 'num': return node.v;
      case 'paren': return constOf(node.v);
      case 'neg': { const v = constOf(node.v); return v === null ? null : -v; }
      case 'bin': {
        const a = constOf(node.l), b = constOf(node.r);
        if (a === null || b === null) return null;
        switch (node.op) {
          case '+': return a + b; case '-': return a - b; case '*': return a * b;
          case '/': return a / b; case '%': return a % b; case '^': return Math.pow(a, b);
        }
        return null;
      }
    }
    return null;
  }

  const PREVIEW_DEPTH = 6;

  /** does this stand on its own, with nothing a bracket could clarify? */
  const atomAst = (n) => !(n.mods && n.mods.length) &&
    (n.t === 'num' || n.t === 'str' || n.t === 'word' || n.t === 'custom' ||
     (n.t === 'dice' && n.qty === null));

  /** a die that has not been rolled, wearing its name rather than a face */
  function ghostDie(shape, face, tag, extra) {
    const size = face.length >= 4 ? ' v4' : (face.length === 3 ? ' v3' : (face.length === 2 ? ' v2' : ''));
    return '<span class="die ghost' + (extra || '') + ' s-' + shape + '"' + tag + '>' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + esc(face) + '</span></span>';
  }

  /** comparisons belong in the preview: they are what the roll is being read for */
  function previewChecks(node, ctx) {
    let out = '';
    for (const m of node.mods || []) {
      if (m.t !== 'check') continue;
      out += '<span class="r-cmp">' + esc(m.bare ? '' : m.check) + CMP_SYM[m.cp.op] + '</span>' +
        (m.cp.node ? previewNode(m.cp.node, ctx)
                   : '<span class="r-num">' + fmt(m.cp.v) + '</span>');
    }
    return out;
  }

  function previewNode(node, ctx) {
    ctx = ctx || { vars: null, depth: 0, mute: false };
    const kid = (n) => previewNode(n, ctx);
    const X = (p) => ctx.mute ? '' : ' data-x="' + p + node.uid + '"';
    // every other modifier shows as a step in the tree below, in the tense of
    // something that has not happened yet
    const steps = noteAttr('data-steps', noteList(node.mods, true));
    const cmp = previewChecks(node, ctx);

    switch (node.t) {
      case 'num': return '<span class="r-num">' + fmt(node.v) + '</span>';
      case 'str': return '<span class="r-str">' + esc(node.v) + '</span>' + cmp;
      /* a variable is opened up, so the preview shows the dice it stands for.
         Its name goes on the bracket below rather than in among the dice. */
      case 'word': {
        const tag = X('w');
        const name = '<span class="r-var"' + tag + '>' + esc(node.name) + '</span>';
        const src = varSrc(node.name, ctx);
        if (src === undefined) return '<span class="r-str"' + tag + '>' + esc(node.name) + '</span>' + cmp;
        if (ctx.depth >= PREVIEW_DEPTH) return name + cmp;
        let ast;
        try { ast = varAst(node.name, src); } catch (e) { return name + cmp; }
        const inner = previewNode(ast, { vars: ctx.vars, depth: ctx.depth + 1, mute: true });
        // as in the result: nothing to bracket when it is a single value
        const open = atomAst(ast) ? '' : '<span class="r-brk"' + tag + '>(</span>';
        const close = atomAst(ast) ? '' : '<span class="r-brk"' + tag + '>)</span>';
        return '<span class="r-grp"' + tag + noteAttr('data-note', [node.name]) + steps + '>' +
          open + inner + close + '</span>' + cmp;
      }
      /* being edited, both answers are still open, so both are spelled out */
      case 'ternary':
        return '<span class="r-kw"' + X('t') + '>if</span>' + kid(node.cond) +
          '<span class="r-kw"' + X('t') + '>then</span>' + kid(node.yes) +
          '<span class="r-kw"' + X('t') + '>else</span>' + kid(node.no);
      case 'band': {
        const kw = (w) => '<span class="r-kw"' + X('b') + '>' + w + '</span>';
        let out = kw('if') + kid(node.subject);
        node.arms.forEach((a, i) => {
          out += (i ? kw('else if') : '') +
            '<span class="r-cmp">' + esc(a.bare ? '' : a.check) + CMP_SYM[a.cp.op] + '</span>' +
            (a.cp.node ? kid(a.cp.node) : '<span class="r-num">' + fmt(a.cp.v) + '</span>') +
            kw('then') + kid(a.then);
        });
        return out + kw('else') + kid(node.otherwise);
      }
      case 'custom':
        return ghostDie(shapeFor(node.items.length), 'D' + node.items.length, X('c'), ' custom') + cmp;
      case 'neg': return '<span class="r-op">-</span>' + kid(node.v);
      case 'bin':
        return kid(node.l) +
          '<span class="r-op"' + (node.uid ? X('o') : '') + '>' + esc(node.op) + '</span>' + kid(node.r);
      case 'func':
        return '<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>' +
          node.args.map(kid).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>';
      case 'paren': case 'set': case 'rep': {
        const tag = X('s');
        const items = (node.t === 'paren' ? [node.v] : node.items).map(kid)
          .join('<span class="r-op">,</span>');
        const pre = node.t === 'rep' ? '<span class="r-num">' + esc(plain(node.count)) + '</span>' : '';
        // `2atk` never had brackets; drawing a pair round what the variable
        // already brackets for itself only reads as a doubled one
        const typed = node.brk[0][0] !== node.brk[0][1];
        const open = typed ? '<span class="r-brk"' + tag + '>(</span>' : '';
        const close = typed ? '<span class="r-brk"' + tag + '>)</span>' : '';
        return '<span class="r-grp"' + tag + steps + '>' + pre +
          open + items + close + '</span>' + cmp;
      }
      case 'dice': {
        const sides = constOf(node.sides);
        const qty = node.qty === null ? 1 : constOf(node.qty);
        const shape = sides === null ? 'd20' : shapeFor(Math.floor(sides));
        const face = sides === null ? 'D?' : 'D' + fmt(Math.floor(sides));
        const n = (qty === null || !(qty >= 0)) ? 1 : Math.floor(qty);
        const shown = Math.max(1, Math.min(n, PREVIEW_MAX));
        const tag = X('d');
        const one = ghostDie(shape, face, tag);
        const squeezed = n > SQUEEZE_AT;
        const parts = new Array(shown).fill(one);
        return '<span class="r-term' + (squeezed ? ' squeezed' : '') + '"' + tag + steps +
          squeezeStyle(shown) + '>' + (squeezed ? parts.join('') : parts.join(PLUS)) +
          '</span>' + cmp;
      }
    }
    return '';
  }

  /* ==========================================================================
     PUBLIC API
     ========================================================================== */
  /* Cutting the source up happens before the parser sees it, so it has to know
     as much about brackets and quotes as the parser does — a comma inside
     either is part of what it sits in, not a separator. */
  function splitParts(src) {
    const out = [];
    let depth = 0, quoted = false, start = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { out.push({ text: src.slice(start, i), a: start }); start = i + 1; }
    }
    out.push({ text: src.slice(start), a: start });
    return out;
  }

  /** where the label starts, or -1. a quoted # is part of the word */
  function labelAt(src) {
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '"') quoted = !quoted;
      else if (src[i] === '#' && !quoted) return i;
    }
    return -1;
  }

  /** the label names the thing — a saved roll, a variable — so it is worth
      splitting off without parsing the rest */
  function splitLabel(input) {
    const src = String(input == null ? '' : input);
    const i = labelAt(src);
    if (i < 0) return { body: src, label: null };
    return { body: src.slice(0, i), label: src.slice(i + 1).trim() || null };
  }

  /* `:=` holds source text and rolls afresh at every mention; `::=` rolls once
     and every mention is that same result. Test the longer one first. */
  const FIXED_RE = /^\s*([a-zA-Z_]+)\s*::=/;
  const ASSIGN_RE = /^\s*([a-zA-Z_]+)\s*:=/;

  function parse(input) {
    const raw = String(input == null ? '' : input);
    let src = raw.trim();
    if (!src) throw new DiceError('nothing to roll', 0);

    let label = null, labelSp = null;
    const hash = labelAt(src);
    if (hash >= 0) {
      label = src.slice(hash + 1).trim();
      labelSp = [hash, src.length];
      src = src.slice(0, hash);
    }

    let repeat = 1, repeatSp = null, offset = 0;
    const rep = /^(\d+)\s*[x×]\s*(?=\S)/i.exec(src);
    if (rep) {
      repeat = Math.max(1, Math.min(parseInt(rep[1], 10), 100));
      repeatSp = [0, rep[0].replace(/\s+$/, '').length];
      offset = rep[0].length;
      src = src.slice(offset);
    }
    if (!src.trim()) throw new DiceError('nothing to roll', offset);

    const parts = [];
    const vars = {};
    const fixed = {};
    let uid = 0;
    for (const piece of splitParts(src)) {
      if (!piece.text.trim()) throw new DiceError('empty roll between commas', offset + piece.a);
      // `name := expr` as a top-level item defines a variable for this expression only
      const fx = FIXED_RE.exec(piece.text);
      const asg = fx || ASSIGN_RE.exec(piece.text);
      const body = asg ? piece.text.slice(asg[0].length) : piece.text;
      const base = offset + piece.a + (asg ? asg[0].length : 0);
      if (asg && !body.trim()) {
        throw new DiceError('"' + asg[1] + ':=" needs an expression after it', base);
      }
      const p = new Parser(body, uid);
      let ast;
      try {
        ast = p.parse();
        typeCheck(ast, false);
      } catch (e) {
        if (e instanceof DiceError && e.pos != null) e.pos += base;
        throw e;
      }
      uid = p.uid;
      if (asg) {
        if (fx) fixed[asg[1]] = ast; else vars[asg[1]] = body;
        const nameA = offset + piece.a + asg[0].indexOf(asg[1]);
        parts.push({
          ast, a: base, src: body, pieceA: offset + piece.a, assign: asg[1], once: !!fx,
          nameSp: [nameA, nameA + asg[1].length], opSp: [base - (fx ? 3 : 2), base]
        });
      } else {
        parts.push({ ast, a: base, src: body, pieceA: offset + piece.a });
      }
    }
    const rolls = parts.filter((x) => !x.assign);
    if (!rolls.length) {
      throw new DiceError('this only sets variables — add something to roll', offset);
    }

    return {
      parts, rolls, vars, fixed, ast: rolls[0].ast, repeat, repeatSp, label, labelSp, offset, src,
      trimmed: raw.trim(),
      notation: parts.map((p) => (p.assign ? p.assign + ':=' : '') + plain(p.ast)).join(', ')
    };
  }

  function inspect(input) {
    const p = parse(input);
    const spans = [], rows = [];
    p.parts.forEach((part, i) => {
      if (part.assign) {
        const aid = 'xa' + i;
        spans.push({ a: part.nameSp[0], b: part.nameSp[1], cls: 't-var', id: aid });
        spans.push({ a: part.opSp[0], b: part.opSp[1], cls: 't-op', id: aid });
        rows.push({
          id: aid, code: part.assign + ':=', depth: 0, title: 'Assignment',
          desc: 'Sets ' + part.assign + ' for this expression only, shadowing any variable ' +
            'of that name in the panel. It is still worked out afresh wherever it is used.'
        });
      }
      const d = describe(part.ast, part.src);
      for (const s of d.spans) spans.push({ a: s.a + part.a, b: s.b + part.a, cls: s.cls, id: s.id });
      for (const r of d.rows) rows.push(Object.assign({}, r));
      if (i < p.parts.length - 1) {
        const c = p.parts[i + 1].pieceA - 1;
        spans.push({ a: c, b: c + 1, cls: 't-op', id: 'xc' + i });
        rows.push({
          id: 'xc' + i, code: ',', depth: 0, title: 'Next roll',
          desc: 'At the top level a comma starts a separate roll, reported alongside the others. ' +
            'Inside brackets the same comma builds a set.'
        });
      }
    });
    spans.sort((x, y) => x.a - y.a || x.b - y.b);

    if (p.repeatSp) {
      spans.unshift({ a: p.repeatSp[0], b: p.repeatSp[1], cls: 't-rep', id: 'xrep' });
      rows.unshift({
        id: 'xrep', code: p.trimmed.slice(p.repeatSp[0], p.repeatSp[1]), depth: 0,
        title: 'Repeat', desc: 'Roll the whole expression ' + p.repeat + ' separate times.'
      });
    }
    if (p.labelSp) {
      spans.push({ a: p.labelSp[0], b: p.labelSp[1], cls: 't-cmt', id: 'xlbl' });
      rows.push({
        id: 'xlbl', code: p.trimmed.slice(p.labelSp[0], p.labelSp[1]), depth: 0,
        title: 'Label', desc: 'Everything after # is a note — it never affects the maths.'
      });
    }
    return { parsed: p, spans, rows, notation: p.notation };
  }

  function slotsFor(fixed) {
    const out = {};
    for (const k in fixed) out[k] = { ast: fixed[k], v: null, busy: false, used: false };
    return out;
  }

  const evaluate = (ast, vars, fixed) =>
    evalNode(ast, { dice: 0, depth: 0, vars: vars || null, fixed: slotsFor(fixed || {}) });

  function countDice(v) {
    if (!v) return 0;
    if (v.die) return 1;
    if (v.set) { let n = 0; for (const m of v.members) n += countDice(m); return n; }
    if (v.inner) return countDice(v.inner) + countDice(v.condVal);
    if (v.parts) { let n = 0; for (const p of v.parts) if (typeof p !== 'string') n += countDice(p); return n; }
    return 0;
  }

  /* Which result types this expression could ever produce — read off the
     checks in the source, not the outcome, so a tally can show a nought for
     the criticals that were possible but did not turn up. */
  function scanMarks(node, out, ctx) {
    if (!node || typeof node !== 'object') return;
    for (const m of node.mods || []) if (m.t === 'check') checkMarks(m, out);
    if (node.t === 'word') {
      const src = varSrc(node.name, ctx);
      const key = node.name + '::' + src;
      if (src !== undefined && !ctx.seen.has(key)) {
        ctx.seen.add(key);
        let ast = null;
        try { ast = varAst(node.name, src); } catch (e) { ast = null; }
        if (ast) scanMarks(ast, out, ctx);
      }
    }
    // a check read by a ? : or used as a count is spent there; only what can
    // still reach the result counts as possible
    for (const k of ['l', 'r', 'v', 'yes', 'no', 'otherwise']) scanMarks(node[k], out, ctx);
    (node.arms || []).forEach((a) => scanMarks(a.then, out, ctx));
    (node.items || []).forEach((x) => scanMarks(x, out, ctx));
    (node.args || []).forEach((x) => scanMarks(x, out, ctx));
  }

  /** a roll that lands on words has those words for a headline, not a number */
  function wordText(v) {
    if (!v || v.dropped) return '';
    if (v.word !== undefined && v.word !== null) return String(v.word);
    if (v.set) return v.live().map(wordText).filter(Boolean).join(', ');
    if (v.inner) return wordText(v.inner);
    if (v.parts) {
      return v.parts.map((x) => typeof x === 'string' ? '' : wordText(x)).filter(Boolean).join(' ');
    }
    return '';
  }

  function possibleMarks(p) {
    const out = new Set(), ctx = { vars: p.vars, seen: new Set() };
    for (const part of p.rolls) scanMarks(part.ast, out, ctx);
    return MARK_ORDER.filter((k) => out.has(k));
  }

  function roll(input) {
    const p = parse(input);
    const sets = [];
    const multi = p.repeat > 1 || p.rolls.length > 1;
    for (let i = 0; i < p.repeat; i++) {
      for (const part of p.rolls) {
        const r = evaluate(part.ast, p.vars, p.fixed);
        if (multi) r.name = p.rolls.length > 1 ? plain(part.ast) : null;
        sets.push(r);
      }
    }
    let diceCount = 0;
    for (const s of sets) diceCount += countDice(s);

    // a non-castable check has no total; the roll reports its marks instead
    let total = 0, numeric = true;
    try { for (const s of sets) total += s.total(); }
    catch (e) { numeric = false; total = 0; }

    const marks = {};
    for (const s of sets) collectMarks(s, marks);

    return {
      input: p.trimmed, notation: p.notation, label: p.label, repeat: p.repeat,
      sets, diceCount, total, numeric, possible: possibleMarks(p),
      text: sets.map(wordText).filter(Boolean).join(', '),
      marks: Object.keys(marks).length ? marks : null
    };
  }

  function preview(input) {
    const p = parse(input);
    const ctx = { vars: p.vars, depth: 0, mute: false };
    return p.rolls.map((part) => previewNode(part.ast, ctx)).join('<span class="r-op">,</span>');
  }

  function analyse(input, n) {
    const p = parse(input);
    n = n || 20000;
    const totals = new Array(n);
    let sum = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (let r = 0; r < p.repeat; r++) {
        for (const part of p.rolls) t += evaluate(part.ast, p.vars, p.fixed).total();
      }
      totals[i] = t; sum += t;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    const mean = sum / n;
    let varsum = 0;
    for (let i = 0; i < n; i++) varsum += (totals[i] - mean) * (totals[i] - mean);
    const sorted = totals.slice().sort((a, b) => a - b);
    return {
      n, min, max, mean, stdev: Math.sqrt(varsum / n),
      median: sorted[Math.floor(n / 2)],
      p10: sorted[Math.floor(n * 0.10)], p90: sorted[Math.floor(n * 0.90)],
      totals, notation: p.notation
    };
  }

  global.DiceEngine = {
    parse, inspect, evaluate, roll, analyse, preview, setVars, fmt, esc, shapeFor,
    splitLabel, DiceError, LIMIT, FUNCS, CHECKS, MARK_ORDER
  };
}(window));
