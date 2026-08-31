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

   Numbers are whole where dice are: `/` divides and throws the fraction away,
   truncating toward zero, so `d100/10` and `d100%10` read the two digits of a
   percentile roll and `(a/b)*b + a%b` still comes back to `a`.

   MODIFIERS declare the type they need, so every mismatch is caught before
   anything is rolled:

     die       e, r, u                   need dice to re-roll
     element   min, max, s, f, cs, cf    applied to each member in turn
     set       kh, kl, dh, dl            need a collection, error on a value
     map       @                         rewrite each member on its own
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
     term    := power (('*' | '/' | '%') power)*      -- '/' is whole-number
     power   := unary (('^' | '**') power)?
     unary   := ('-' | '+')? primary
     primary := number ['(' list ')' | 'd' sides | word | custom] modifier*
              | '(' list ')' modifier*  | '[' list ']' modifier*
              | func '(' list ')'       | '{' name '}' modifier*
              | '"' text '"' modifier*  | word modifier*
              | 'd' sides modifier*
     list    := expr (',' expr)*
     modifier:= name [comparison] | '@' op unary
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
    totalDice: 20000, repeat: 1000, varDepth: 24, combos: 48
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

  /* Three functions, all of them the same shape: several values in, one out.
     sum() is the one that says out loud what everything else does quietly. */
  const FUNCS = {
    max: Math.max,
    min: Math.min,
    sum: function () { let t = 0; for (let i = 0; i < arguments.length; i++) t += arguments[i]; return t; }
  };
  const FUNC_DESC = {
    max: 'the largest value', min: 'the smallest value', sum: 'everything added up'
  };

  /* which structural type each modifier needs, and the order they run in */
  const MODS = {
    min: { kind: 'element', order: 1 },
    max: { kind: 'element', order: 2 },
    explode: { kind: 'die', order: 3 },
    reroll: { kind: 'die', order: 4 },
    unique: { kind: 'set', order: 5, dice: true },
    keep: { kind: 'set', order: 6 },
    drop: { kind: 'set', order: 7 },
    /* Arithmetic sums a set before touching it. This is the way round that —
       the one modifier that hands back a different value than it was given,
       so it runs after the survivors are settled and before they are read. */
    map: { kind: 'map', order: 8 },
    check: { kind: 'element', order: 9 },
    /* Advantage is the odd one out: every other modifier reshapes what a roll
       produced, while this one rolls the whole term again. It is handled where
       evaluation begins rather than in applyMods, and has to be written last. */
    adv: { kind: 'repeat', order: 10 }
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

  /* the operators a map may use, longest first so ** is not read as * */
  const MAP_OPS = ['**', '^', '*', '/', '%', '+', '-'];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* Division is whole-number, truncated toward zero: dice deal in whole
     numbers, and rounding here is what lets `/` and `%` read digits off a roll. */
  const idiv = (a, b) => Math.trunc(a / b);
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
      const arms = [{ cp: lead.cp, check: lead.check, bare: !!lead.bare, each: !!lead.each,
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
        // every arm is about the same subject, so they are all about it the same way
        arms.push({ cp, check: 's', bare: true, each: !!lead.each, then, sp: [a, qq],
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
          this.fail('unknown function "' + name + '" — there are only max, min and sum');
        }
        const nameSp = [a, a + fn[1].length];
        this.i += fn[0].length;
        const openSp = [this.i - 1, this.i];
        const { items } = this.list();
        const cA = this.mark();
        if (!this.lit(')')) this.fail('expected ")" to close ' + name + '()');
        const mods = this.modifiers();
        return { t: 'func', name, args: items, mods, nameSp,
                 brk: [openSp, [cA, this.i]], core: [a, cA + 1], sp: [a, this.i] };
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
        const at = this.mark();
        const v = this.signedInt();
        /* A plain integer is taken where there is one, so 3d6>=5+1 is (3d6>=5)+1
           rather than a surprise. A number that turns out to be a dice count is
           not that number, though: in d6=2d6 the 2 belongs to the dice after it,
           and reading it as the whole side leaves a stray dl6 behind.

           The span is kept because what is compared against is a value in its
           own right, and is drawn as one rather than as part of the comparison. */
        if (v !== null && !this.atDice()) return { op: name, v, sp: [at, this.i] };
        if (v !== null) this.i = at;
        // not a plain number, so the other side is an expression of its own
        try {
          const node = this.primary();
          return { op: name, node, sp: [at, this.i] };
        } catch (e) { this.i = save; return null; }
      }
      return null;
    }

    /* A modifier's count: a plain number, or a bracket worked out at roll time.
       Returns null when there is neither, so a caller can fall back. */
    countArg(signed) {
      const at = this.mark();
      if (this.peek() === '(') {
        this.lit('(');
        const node = this.expr();
        if (!this.lit(')')) this.fail('expected ")" after a count');
        return { nNode: node, nSp: [at, this.i] };
      }
      const n = signed ? this.signedInt() : this.digits();
      return n === null ? null : { n, nSp: [at, this.i] };
    }

    /** the same, with what to fall back to when nothing is written */
    count(dflt, signed) {
      const c = this.countArg(signed);
      return c || (dflt === null ? null : { n: dflt });
    }

    /** an explicit comparison, or a bare number in the modifier's direction */
    cpDir(dir) {
      const cp = this.comparePoint();
      if (cp) return cp;
      const c = this.countArg(false);
      if (!c) return null;
      return c.nNode ? { op: dir, node: c.nNode, sp: c.nSp } : { op: dir, v: c.n, sp: c.nSp };
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
        if (m.t === 'adv' && !m.nNode) {
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

      /* `@` says "to each member". Everything else is about the term's own
         value, which for a set is its total — so `2d6e` explodes on a total of
         12 and `2d6@e` explodes each die on 6.

         Followed by an operator it is arithmetic, one operator and one operand
         at a time: `2d6@*2+3` doubles each die and then adds 3 once, and
         `@*2@+3` does both to each. Followed by a name it is that modifier,
         applied a member at a time. */
      if (this.lit('@')) {
        const oA = this.mark();
        const op = MAP_OPS.find((x) => this.lit(x));
        if (op) {
          return this.fin(start, {
            t: 'map', op: op === '**' ? '^' : op, opSp: [oA, this.i], r: this.unary()
          });
        }
        const inner = this.modifier();
        if (!inner) this.fail('expected an operator or a modifier after "@", like 2d6@*2 or 2d6@e');
        if (inner.t === 'map') this.fail('"@" is already about each member; one is enough');
        inner.each = true;
        return this.fin(start, inner);
      }

      if (this.lit('min')) {
        const c = this.count(null, true);
        return c === null ? back() : this.fin(start, Object.assign({ t: 'min' }, c));
      }
      if (this.lit('max')) {
        const c = this.count(null, true);
        return c === null ? back() : this.fin(start, Object.assign({ t: 'max' }, c));
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
        const c = cp ? null : this.countArg(false);
        return this.fin(start, Object.assign({ t: 'unique', tries: 0, cp },
          c ? (c.nNode ? { triesNode: c.nNode, triesSp: c.nSp }
                       : { tries: c.n, triesSp: c.nSp }) : {}));
      }

      /* `da` has to be tried before the `d` that starts dh/dl/drop, which would
         otherwise match its first letter and give up on the whole modifier */
      if (this.lit('da')) return this.fin(start, Object.assign({ t: 'adv', end: 'l' }, this.count(2)));
      if (this.lit('a')) return this.fin(start, Object.assign({ t: 'adv', end: 'h' }, this.count(2)));

      if (this.lit('kh')) return this.fin(start, Object.assign({ t: 'keep', end: 'h' }, this.count(1)));
      if (this.lit('kl')) return this.fin(start, Object.assign({ t: 'keep', end: 'l' }, this.count(1)));
      if (this.lit('dh')) return this.fin(start, Object.assign({ t: 'drop', end: 'h' }, this.count(1)));
      if (this.lit('dl')) return this.fin(start, Object.assign({ t: 'drop', end: 'l' }, this.count(1)));
      if (this.lit('d')) {
        const c = this.count(null);
        return c === null ? back() : this.fin(start, Object.assign({ t: 'drop', end: 'l' }, c));
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
      if ((spec.kind === 'die' || spec.dice) && m.each && node.t !== 'dice') {
        throw new DiceError('"' + modText(m) + '" marked with "@" is about each die, ' +
          'so it has to attach to dice', m.sp && m.sp[0]);
      }
      // advantage sums each attempt before comparing, so it needs a number
      if (m.t === 'adv') {
        const c = checkOf(node);
        if (c && !CHECKS[c].castable) {
          throw new DiceError('advantage compares sums, and a ' + CHECKS[c].label.toLowerCase() +
            ' carries no number', m.sp && m.sp[0]);
        }
      }
      /* Only what acts on a member one at a time can be marked. Keeping or
         dropping is a choice made between members, and advantage rolls the whole
         term again — neither is something a single member can be asked about. */
      if (m.each && spec && (spec.kind === 'set' || spec.kind === 'repeat')) {
        throw new DiceError('"' + modText(m) + '" is about the set as a whole, ' +
          'so it cannot be marked with "@"', m.sp && m.sp[0]);
      }
      /* A name can hold either, and what it holds is not known until it is
         rolled, so only a term that says outright what it is can be refused. */
      if (m.each && node.t !== 'word' && !isSet(node)) {
        throw new DiceError('"@" is about the members of a set, and there is only ' +
          'one value here', m.sp && m.sp[0]);
      }
      if (m.t === 'map') {
        if (isSet(m.r)) {
          throw new DiceError('"@" applies one value to each member, so what follows it ' +
            'has to be a single value, not a set', m.r.sp && m.r.sp[0]);
        }
        typeCheck(m.r, true);
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
    const n = cnt(m);
    switch (m.t) {
      case 'min': return w('floor at ', 'floored at ') + n;
      case 'max': return w('cap at ', 'capped at ') + n;
      case 'explode': return (m.pen ? w('penetrate', 'penetrated') : w('explode', 'exploded')) +
        (m.inf ? ' repeatedly' : '');
      case 'reroll': return w('re-roll', 're-rolled') + (m.inf ? ' repeatedly' : '');
      case 'unique': return w('make unique', 'made unique');
      case 'keep': return w('keep ', 'kept ') + n + ' ' + end(m.end);
      case 'drop': return w('drop ', 'dropped ') + n + ' ' + end(m.end);
      case 'check': return CHECK_SHORT[m.check] + ' on ' + cpShort(m.cp);
      case 'map': return w('each ', 'each ') + m.op + plain(m.r);
      case 'adv': {
        const best = m.end === 'h';
        if (!m.nNode && m.n === 2) return best ? 'advantage' : 'disadvantage';
        return (best ? 'best of ' : 'worst of ') + n;
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

  /* A bracket spanning one value has nothing to span. Saying so lets the
     display draw a line from the name to it instead of a bracket over it. */
  function isLone(item) {
    if (item.inner) return !!item.inner.atom;
    if (item.set) { const live = item.live(); return live.length === 1 && !!live[0].atom; }
    return false;
  }

  /** what the subtotal bracket needs to know beyond its number */
  function stateAttr(o, item) {
    const mark = markOf(item);
    return (isDropped(o, item) ? ' data-drop="1"' : '') +
      (isLone(item) ? ' data-lone="1"' : '') +
      (mark ? ' data-mark="' + mark + '"' : '') +
      noteAttr('data-note', item.note ? [item.note] : []) +
      noteAttr('data-steps', noteList(item.mods, false));
  }

  /* --------------------------------------------------------------- values
     Every rolled thing answers the same questions, so they share one
     prototype and each kind supplies only what differs:

       raw()    the number underneath, never consulting the check
       total()  the number it counts as, which a check can replace
       base()   the same, ignoring a verdict already pinned on from outside
       value    what a comparison sees: a word if it has one, else base()
       cond()   true, false, or null when it is not a yes-or-no at all
       html(o)  markup, with `o` carrying state inherited from above

     raw() exists because total() can throw and the display must not: a
     terminal result type has no number, yet still has to be drawn. */
  const VALUE = {
    set: false, die: false, atom: false, custom: false,
    check: null, dropped: false, note: null, uid: 0, mods: null,
    raw() { return 0; },
    total() { const c = checkTotal(this); return c === null ? this.raw() : c; },
    /* What a comparison reads this as. It is total(), not raw(), because a
       set of checked dice counts as its hits — that is what lets `h::=4d6=6`
       then `h>=2` ask about two sixes rather than about their faces. Its own
       check is set aside first, so every arm of a chain reads the same number
       rather than the verdict the arm before it wrote. */
    base() {
      const c = this.check;
      if (!c) return this.total();
      this.check = null;
      try { return this.total(); } finally { this.check = c; }
    },
    cond() {
      if (this.check) return this.check.hit;
      return this.inner ? this.inner.cond() : null;
    },
    get value() {
      const w = this.word;
      return (w === undefined || w === null) ? this.base() : w;
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
        return '<span class="' + cls.join(' ') + '"' + tag + ' title="custom die">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
          '<use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval">' + esc(String(face)) + '</span></span>';
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
    let badge = '';
    if (r.from !== null && r.from !== undefined) badge = '<s>' + esc(fmt(r.from)) + '</s>';
    else if (r.tags.indexOf('exploded') >= 0) badge = '!';
    const title = (r.tags.length ? r.tags.join(', ') : 'natural') +
      (isDropped(o, item) ? ', dropped' : '') + (mk ? ',' + mk : '');
    return '<span class="' + cls.join(' ') + '"' + tag + ' title="' + esc(title) + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval">' + esc(face) + '</span>' +
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

  /* What a modifier's count comes to now. A bracket is thrown afresh every time
     it is asked, which is the point of writing one — a count that should stay
     put is what a ::= binding is for. */
  function countOf(m, ctx, key) {
    const node = m[(key || 'n') + 'Node'];
    if (!node) return m[key || 'n'];
    const v = Math.floor(num(node, ctx));
    if (!isFinite(v)) throw new DiceError('a count has to come to a number');
    return v;
  }
  const num = (node, ctx) => evalNode(node, ctx).total();

  /* Infinity and NaN mean nothing as a roll, so they are an error here rather
     than a total nobody can read. A sum and a map both come through here. */
  function arith(op, a, b, sp) {
    let v;
    switch (op) {
      case '+': v = a + b; break;
      case '-': v = a - b; break;
      case '*': v = a * b; break;
      case '/': v = idiv(a, b); break;
      case '%': v = a % b; break;
      case '^': v = Math.pow(a, b); break;
    }
    if (!isFinite(v)) {
      throw new DiceError(b === 0 && (op === '/' || op === '%')
        ? 'cannot divide by zero'
        : 'that works out to a number too big to use', sp && sp[0]);
    }
    return v;
  }

  function applyDieMods(rolls, sides, mods, ctx, single) {
    const tag = (r, t) => { if (r.tags.indexOf(t) < 0) r.tags.push(t); };
    let out = rolls;
    // a lone die is its own total, so there it makes no difference either way
    const die = mods.filter((x) => MODS[x.t] && MODS[x.t].kind === 'die' && (x.each || single))
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
      const n = countOf(m, ctx);
      const over = m.t === 'min' ? item.roll.v < n : item.roll.v > n;
      if (!over) return;
      if (item.roll.from === null) item.roll.from = item.roll.v;
      item.roll.v = n;
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

  /* Every other modifier reshapes what it was handed; this one replaces it.
     The right-hand side is worked out once per member, the same way a
     comparison is, so `2d6@*d4` rolls a fresh d4 for each die. A member already
     thrown away is left as it is: it takes no further part.

     The set's own markup closes over the members array, so the rewritten
     members go back into that same array rather than into a new set. */
  function applyMap(value, m, ctx) {
    const one = (item) => {
      if (item.dropped) return item;
      const r = evalNode(m.r, ctx);
      const v = arith(m.op, item.total(), r.total(), m.opSp);
      return Expr(v, [item, '<span class="r-op">' + esc(m.op) + '</span>', r]);
    };
    if (!value.set) return one(value);
    value.members.splice(0, value.members.length, ...value.members.map(one));
    return value;
  }

  /* A modifier with no @ is about the term's own value. A check simply lands on
     it — a set that carries one counts as its verdict rather than as its
     members. A clamp has to hand back a different number, unless the value is a
     lone die, where moving the face is what a clamp has always meant. */
  function applyWhole(value, m, ctx) {
    if (m.t === 'check' || value.roll) { applyElement(value, m, ctx); return value; }
    if (m.t !== 'min' && m.t !== 'max') return value;
    const t = safeTotal(value), n = countOf(m, ctx);
    const v = m.t === 'min' ? Math.max(t, n) : Math.min(t, n);
    return v === t ? value : Expr(v, [value]);
  }

  function applySet(value, m, sides, ctx) {
    if (!value.set) throw new DiceError('"' + modText(m) + '" needs a set of values');
    const members = value.members;
    if (m.t === 'keep' || m.t === 'drop') {
      const n = Math.max(0, countOf(m, ctx));
      const live = members.filter((x) => !x.dropped);
      const order = live.slice().sort((a, b) => safeTotal(b) - safeTotal(a));
      if (m.t === 'keep') {
        const keep = new Set(n === 0 ? [] : (m.end === 'l' ? order.slice(-n) : order.slice(0, n)));
        for (const x of live) if (!keep.has(x)) x.dropped = true;
      } else if (n) {
        for (const x of (m.end === 'h' ? order.slice(0, n) : order.slice(-n))) x.dropped = true;
      }
      return;
    }
    if (m.t === 'unique') {
      const seen = new Set();
      const cap = countOf(m, ctx, 'tries') || LIMIT.reroll;
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
      // a map hands back a different value, so it is the one that is assigned
      if (kind === 'map') value = applyMap(value, m, ctx);
      else if (kind !== 'element') applySet(value, m, sides, ctx);
      else if (m.each) eachMember(value, (item) => applyElement(item, m, ctx));
      else value = applyWhole(value, m, ctx);
    }
    if (mods && mods.length) value.mods = mods;   // the subtotal bracket names them
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
    rolls = applyDieMods(rolls, sides, node.mods, ctx, single);

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

  /** is this modifier about the term's total rather than about its dice? */
  const aboutTerm = (node, m) =>
    (m.t === 'explode' || m.t === 'reroll') && !m.each &&
    !(node.t === 'dice' && node.qty === null);

  /* What counts as "the highest" or "the lowest" when it is a total being
     watched rather than a face. Written out, it is whatever you wrote; left
     out, it is the most or least the term could ever come to. */
  function termCp(node, m, ctx) {
    if (m.cp) return m.cp;
    const b = boundsOf(node, { vars: ctx.vars, fixed: ctx.fixed, seen: new Set() });
    if (!b) {
      throw new DiceError('"' + modText(m) + '" here is about the total, and there is no ' +
        'saying what its ' + (m.t === 'explode' ? 'highest' : 'lowest') + ' total is — ' +
        'write the comparison out, like (2d6)' + modText(m) + '>=11', m.sp && m.sp[0]);
    }
    return { op: '=', v: m.t === 'explode' ? b.max : b.min };
  }

  function rollTerm(node, m, ctx) {
    const once = Object.assign({}, node, { mods: node.mods.filter((x) => x !== m) });
    const cp = termCp(once, m, ctx);
    const uid = uidOf(node, ctx);
    const cap = m.t === 'explode' ? LIMIT.explode : LIMIT.reroll;
    const tries = [evalNode(once, ctx)];
    let n = 0;

    while (cpTest(cp, safeTotal(tries[tries.length - 1]), ctx) && n < cap) {
      n++;
      // a re-roll replaces what came before; an explosion is added to it
      if (m.t === 'reroll') tries[tries.length - 1].dropped = true;
      let next = evalNode(once, ctx);
      if (m.t === 'explode' && m.pen) next = Expr(safeTotal(next) - 1, [next, PLUS, Val(-1)]);
      tries.push(next);
      if (!m.inf) break;
    }
    const out = SetVal(tries, { uid, brackets: tries.length > 1 });
    out.mods = [m];
    return out;
  }

  /* Advantage rolls the term again rather than reshaping one roll, so it wraps
     evaluation instead of joining the modifier chain. Each attempt keeps its
     own shape but is compared by its sum — that is what makes `2d6a` the better
     of two totals rather than the best of four dice. */
  function rollAdv(node, m, ctx) {
    const once = Object.assign({}, node, { mods: node.mods.filter((x) => x !== m) });
    const n = countOf(m, ctx);
    if (!(n >= 1)) throw new DiceError('advantage needs at least one roll', m.sp && m.sp[0]);
    if (n > LIMIT.repeat) throw new DiceError('too many rolls (max ' + LIMIT.repeat + ')', m.sp && m.sp[0]);
    const tries = [];
    for (let i = 0; i < n; i++) tries.push(evalNode(once, ctx));
    const out = SetVal(tries, { uid: uidOf(node, ctx), brackets: tries.length > 1 });
    out.mods = [m];
    applySet(out, { t: 'keep', end: m.end, n: 1 }, null, ctx);
    return out;
  }

  /* A `::=` binding is thrown once and then referred to, which is what lets a
     chain of comparisons ask about the same roll several times. It holds
     whatever was thrown — a set stays a set, exactly as it would under `:=`.
     The two differ in when the dice are thrown and in nothing else.

     Every mention gets its own wrapper around the same underlying values, so
     two mentions can ask two different questions without one overwriting the
     other's answer. The dice are counted once, at the first mention. */
  /* One member of a set being named again: it shows the face that was thrown,
     and carries any verdict of its own rather than the one the last mention
     left on the die. */
  function mirror(inner) {
    return value({
      word: inner.word,
      raw() { return inner.raw(); },
      html(o) {
        return '<span class="r-ref' + stateCls(o, this) + '"><i></i>' +
          esc(fmt(inner.raw())) + '</span>';
      }
    });
  }

  function refSet(inner, name, uid) {
    const out = SetVal(inner.members.map(mirror),
      { uid, brackets: true, note: name, tag: 'w' });
    out.ref = true;
    return out;
  }

  function fixedValue(node, slot, ctx) {
    if (!slot.v) {
      if (slot.busy) throw new DiceError('"' + node.name + '" is defined in terms of itself');
      slot.busy = true;
      slot.v = evalNode(slot.ast, ctx);
      slot.busy = false;
    }
    const uid = uidOf(node, ctx);
    let wrapped;
    if (slot.v.set) {
      wrapped = slot.used ? refSet(slot.v, node.name, uid)
        : SetVal(slot.v.members, { uid, brackets: true, note: node.name, tag: 'w' });
    } else {
      wrapped = slot.used ? Ref(slot.v, node.name, uid)
        : Group(slot.v, uid, { note: node.name, tag: 'w', bare: !!slot.v.atom });
    }
    slot.used = true;
    return applyMods(wrapped, node.mods || [], null, ctx);
  }

  function evalNode(node, ctx) {
    const adv = (node.mods || []).find((x) => x.t === 'adv');
    if (adv) return rollAdv(node, adv, ctx);
    const whole = (node.mods || []).find((x) => aboutTerm(node, x));
    if (whole) return rollTerm(node, whole, ctx);

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
      /* The choice goes the way its condition went. A comparison marked with @
         left one verdict per member, so there is one answer per member; one
         about the whole term leaves one verdict, and one answer. */
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
        if (!c.set || c.check) return answer(c);
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
        if (!v.set || !node.arms[0].each) return answer(v);
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
        const v = arith(node.op, l.total(), r.total(), node.opSp);
        const tag = uidOf(node, ctx) ? ' data-x="o' + node.uid + '"' : '';
        return Expr(v, [l, '<span class="r-op"' + tag + '>' + esc(node.op) + '</span>', r]);
      }

      case 'func': {
        const args = node.args.map((a) => evalNode(a, ctx));
        const nums = [];
        for (const p of args) {
          if (p.set) { for (const m of p.members) if (!m.dropped) nums.push(m.total()); }
          else nums.push(p.total());
        }
        const v = FUNCS[node.name].apply(null, nums);
        const parts = ['<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>'];
        args.forEach((p, i) => {
          if (i) parts.push('<span class="r-op">,</span>');
          parts.push(p);
        });
        parts.push('<span class="r-brk">)</span>');
        return applyMods(Expr(v, parts), node.mods || [], null, ctx);
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
    return (m.each ? '@' : '') + modBody(m);
  }

  /* A written-out count keeps its brackets, since that is what says it is worked
     out afresh rather than fixed. */
  const cnt = (m, key) => m[(key || 'n') + 'Node']
    ? '(' + plain(m[(key || 'n') + 'Node']) + ')' : String(m[key || 'n']);

  function modBody(m) {
    switch (m.t) {
      case 'min': return 'min' + cnt(m);
      case 'max': return 'max' + cnt(m);
      case 'explode': return 'e' + (m.pen ? 'p' : '') + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'reroll': return 'r' + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'unique': return 'u' + (m.triesNode ? cnt(m, 'tries') : (m.tries || '')) + cpText(m.cp);
      case 'keep': return 'k' + m.end + cnt(m);
      case 'drop': return 'd' + m.end + cnt(m);
      case 'check': return (m.bare ? '' : m.check) + cpText(m.cp);
      case 'map': return '@' + m.op + plain(m.r);
      case 'adv': return (m.end === 'h' ? 'a' : 'da') +
        (m.nNode ? cnt(m) : (m.n === 2 ? '' : m.n));
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
          s += (i ? ':' : '') + (i || !a.each ? '' : '@') +
            (a.bare ? '' : a.check) + cpText(a.cp) + '?' + plain(a.then);
        });
        return s + ':' + plain(node.otherwise);
      }
      case 'neg': return '-' + plain(node.v);
      case 'bin': return plain(node.l) + node.op + plain(node.r);
      case 'func': return node.name + '(' + node.args.map(plain).join(',') + ')' + mods;
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

  /** what a bracketed count means, for anything that can carry one */
  const thrown = (m, key) => m[(key || 'n') + 'Node']
    ? ' The count is worked out afresh every time this runs.' : '';

  function modExplain(m) {
    switch (m.t) {
      case 'min': return ['Minimum', 'Anything below ' + cnt(m) + ' counts as ' + cnt(m) + '.' + thrown(m)];
      case 'max': return ['Maximum', 'Anything above ' + cnt(m) + ' counts as ' + cnt(m) + '.' + thrown(m)];
      case 'explode': return [m.pen ? 'Penetrating explode' : 'Exploding',
        'When a die rolls ' + cpPhrase(m.cp, 'its highest face') + ', roll an extra die and add it' +
        (m.pen ? ', subtracting 1 from every extra roll' : '') + '.' +
        (m.inf ? ' Repeats while it keeps happening.' : ' One extra roll per die.')];
      case 'reroll': return ['Re-roll',
        'Any die showing ' + cpPhrase(m.cp, 'its lowest face') + ' is re-rolled' +
        (m.inf ? ' until it no longer qualifies.' : ' once — the new value stands.')];
      case 'unique': return ['Unique',
        'Duplicates are re-rolled' +
        ((m.tries || m.triesNode) ? ' up to ' + cnt(m, 'tries') + ' times' : '') +
        ' so every die shows a different value. Needs a set.'];
      case 'keep': return ['Keep ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Keep the ' + (!m.nNode && m.n === 1 ? '' : cnt(m) + ' ') +
        (m.end === 'h' ? 'highest' : 'lowest') +
        ' member; the rest are struck out. Needs a set.' + thrown(m)];
      case 'drop': return ['Drop ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Throw away the ' + (!m.nNode && m.n === 1 ? '' : cnt(m) + ' ') +
        (m.end === 'h' ? 'highest' : 'lowest') + ' member. Needs a set.' + thrown(m)];
      case 'map': return ['Each',
        'Apply ' + m.op + plain(m.r) + ' to every member on its own, instead of to the sum. ' +
        'The right side is worked out afresh for each one, so 2d6@*d4 rolls a d4 per die. ' +
        'One operator at a time — chain another @ for more.'];
      case 'adv': {
        const best = m.end === 'h' ? 'best' : 'worst';
        return [m.end === 'h' ? 'Advantage' : 'Disadvantage',
          'Roll everything to the left ' +
          (!m.nNode && m.n === 2 ? 'twice' : cnt(m) + ' times') +
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
    '/': ['Divide', 'Whole numbers only — the fraction is dropped, so 7/2 is 3. ' +
      'Together with % this reads the digits of a roll: d100/10 is the tens, d100%10 the units.'],
    '%': ['Remainder', 'What is left after whole-number division.'],
    '^': ['Power', 'Raise the left side to the power of the right.']
  };

  function describe(ast, src, vars) {
    const spans = [], rows = [];
    let uid = 0;
    // a bare word only reads as a variable while one of that name is set
    const known = (name) =>
      (vars && vars[name] !== undefined) || VARS[name] !== undefined;

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
        /* Whatever number the modifier is written against — a count, a
           comparison point, the right of a map — is an operand in its own
           right, so the modifier's own span stops where that operand starts. */
        const operand = (m.cp && m.cp.sp) || (m.t === 'map' && m.r && m.r.sp) ||
          m.nSp || m.triesSp || null;
        push([m.sp[0], operand ? operand[0] : m.sp[1]], 't-mod',
          { title, desc, depth: depth + 1 });
        if (!operand) continue;
        const sub = (m.cp && m.cp.node) || (m.t === 'map' && m.r) || m.nNode || m.triesNode;
        if (sub) walk(sub, depth + 1);
        else push(operand, 't-num', null);
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
        case 'word': {
          const isVar = node.forced || known(node.name);
          push(node.sp, isVar ? 't-var' : 't-str', {
            title: node.forced ? 'Variable' : (isVar ? 'Variable' : 'Word'),
            desc: node.forced
              ? 'Always the variable ' + node.name + ', worked out afresh wherever it appears.'
              : (isVar
                ? 'The variable ' + node.name + ', worked out afresh wherever it appears. ' +
                  'Unset it and this becomes the plain word ' + node.name + '; write {' +
                  node.name + '} to insist on the variable.'
                : 'The word ' + node.name + '. Words carry no number, so a word can only be a ' +
                  'result. Set a variable of that name and this becomes the variable instead.'),
            depth
          }, 'w' + node.uid);
          mods(node, depth);
          break;
        }
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
            const val = a.cp && a.cp.sp;
            push([a.sp[0], val ? val[0] : a.sp[1]], 't-mod', {
              title: i ? 'Or when' : 'When',
              desc: 'If what came before is ' + cpPhrase(a.cp) + ', the answer is what ' +
                'follows the ?. The comparisons are tried in the order written, on the ' +
                'one result — nothing is rolled again.',
              depth
            }, bid);
            if (val) { if (a.cp.node) walk(a.cp.node, depth + 1); else push(val, 't-num', null); }
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
          mods(node, depth);
          break;
        case 'dice': {
          const many = node.qty !== null;
          const q = many ? plain(node.qty) : '1';
          const sides = node.sides.t === 'num' ? plain(node.sides) : '(' + plain(node.sides) + ')';
          if (many) {
            if (node.qty.t === 'num') push(node.qty.sp, 't-num', null);
            else walk(node.qty, depth + 1);
          }
          push([many ? node.qty.sp[1] : node.core[0], node.core[1]], 't-dice', {
            title: many ? 'Dice — a set' : 'One die — a value',
            desc: many
              ? 'Roll ' + q + ' ' + sides + '-sided dice. That is a set of ' + q +
                ' values, summed whenever a single value is needed.'
              : 'Roll one ' + sides + '-sided die. A single value, not a set — ' +
                'set modifiers like kh will not attach to it.',
            depth
          }, 'd' + node.uid);
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
          push(node.count.sp, 't-num', {
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
          case '/': return idiv(a, b); case '%': return a % b; case '^': return Math.pow(a, b);
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

  /* A die that has not been rolled, wearing its name rather than a face. Every
     die value and every die name is drawn at one size, whatever its length: a
     D8 and a D10 sitting side by side have to read as the same kind of thing,
     and a long one spilling over its shape is better than one too small to
     read. */
  function ghostDie(shape, face, tag, extra) {
    return '<span class="die ghost' + (extra || '') + ' s-' + shape + '"' + tag + '>' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval">' + esc(face) + '</span></span>';
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
        return '<span class="r-grp"' + tag + noteAttr('data-note', [node.name]) + steps +
          (atomAst(ast) ? ' data-lone="1"' : '') + '>' + open + inner + close + '</span>' + cmp;
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
          node.args.map(kid).join('<span class="r-op">,</span>') +
          '<span class="r-brk">)</span>' + cmp;
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

  function repeatPrefix(src) {
    const flat = /^(\d+)\s*[x×]\s*(?=\S)/i.exec(src);
    if (flat) {
      return { n: parseInt(flat[1], 10), len: flat[0].length,
               end: flat[0].replace(/\s+$/, '').length };
    }
    if (src[0] !== '(') return null;
    let depth = 0, quoted = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) { if (c === '"') quoted = false; continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        const after = /^\s*[x×]\s*(?=\S)/i.exec(src.slice(i + 1));
        if (!after) return null;
        return { src: src.slice(1, i), len: i + 1 + after[0].length,
                 end: i + 1 + after[0].replace(/\s+$/, '').length };
      }
    }
    return null;
  }

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

    let repeat = 1, repeatNode = null, repeatSp = null, repCountSp = null, offset = 0;
    const rep = repeatPrefix(src);
    if (rep) {
      if (rep.src !== undefined) {
        try { repeatNode = typeCheck(new Parser(rep.src).parse(), true); }
        catch (e) { if (e instanceof DiceError && e.pos != null) e.pos += 1; throw e; }
      } else {
        repeat = Math.max(1, Math.min(rep.n, LIMIT.repeat));
      }
      repeatSp = [0, rep.end];
      repCountSp = [0, rep.src !== undefined ? rep.src.length + 2 : String(rep.n).length];
      offset = rep.len;
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

    // the prefix belongs to the notation, or a repeated roll loses its repeat
    const shown = repeatNode ? '(' + plain(repeatNode) + ')x ' : (repeat > 1 ? repeat + 'x ' : '');
    return {
      parts, rolls, vars, fixed, ast: rolls[0].ast, repeat, repeatNode, repeatSp, repCountSp,
      label, labelSp, offset, src, trimmed: raw.trim(),
      notation: shown + parts.map((p) =>
        (p.assign ? p.assign + (p.once ? '::=' : ':=') : '') + plain(p.ast)).join(', ')
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
          id: aid, code: part.assign + (part.once ? '::=' : ':='), depth: 0,
          title: part.once ? 'Assignment, rolled once' : 'Assignment',
          desc: 'Sets ' + part.assign + ' for this expression only, shadowing any variable ' +
            'of that name in the panel. ' + (part.once
              ? 'It is rolled once and every mention is that same result, which is what ' +
                'lets several comparisons ask about one roll. It stands for what the roll ' +
                'came to, so it is a value and never a set.'
              : 'It is worked out afresh wherever it is used.')
        });
      }
      const d = describe(part.ast, part.src, p.vars);
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
      // the count is a value; only the x that follows it belongs to the repeat
      const c = p.repCountSp || p.repeatSp;
      spans.unshift({ a: c[1], b: p.repeatSp[1], cls: 't-rep', id: 'xrep' });
      spans.unshift({ a: c[0], b: c[1], cls: 't-num', id: 'xrep' });
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

  const rollCtx = (p) =>
    ({ dice: 0, depth: 0, vars: p.vars || null, fixed: slotsFor(p.fixed || {}) });
  const evaluate = (ast, vars, fixed) => evalNode(ast, rollCtx({ vars, fixed }));

  function countDice(v) {
    if (!v) return 0;
    if (v.ref) return 0;              // the same dice, named again
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
    let reps = p.repeat;
    if (p.repeatNode) {
      reps = Math.floor(evaluate(p.repeatNode, p.vars, p.fixed).total());
      if (!(reps >= 0)) throw new DiceError('how many times to roll has to be 0 or more');
      if (reps > LIMIT.repeat) throw new DiceError('too many repeats (max ' + LIMIT.repeat + ')');
    }
    const multi = reps > 1 || p.rolls.length > 1;
    for (let i = 0; i < reps; i++) {
      const ctx = rollCtx(p);
      for (const part of p.rolls) {
        const r = evalNode(part.ast, ctx);
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
      input: p.trimmed, notation: p.notation, label: p.label, repeat: reps,
      sets, diceCount, total, numeric, possible: possibleMarks(p),
      defs: p.parts.filter((x) => x.assign && !x.once)
        .map((x) => x.assign + ' := ' + plain(x.ast)),
      text: sets.map(wordText).filter(Boolean).join(', '),
      marks: Object.keys(marks).length ? marks : null
    };
  }

  function preview(input) {
    const p = parse(input);
    const ctx = { vars: p.vars, fixed: p.fixed, depth: 0, mute: false };
    return p.parts.map((part) => (part.assign
      ? '<span class="r-var">' + esc(part.assign) + '</span>' +
        '<span class="r-op">' + (part.once ? '::=' : ':=') + '</span>'
      : '') + previewNode(part.ast, ctx)).join('<span class="r-op">,</span>');
  }

  /* ==========================================================================
     WHAT AN EXPRESSION CAN COME TO
     A simulation only ever shows what turned up. These say what could: every
     word it might end on, and how small or large a number it might reach.
     ========================================================================== */

  /** every word the result could be, in the order they are written */
  function wordsOf(node, out, ctx) {
    if (!node || typeof node !== 'object') return;
    switch (node.t) {
      case 'str': if (out.indexOf(node.v) < 0) out.push(node.v); return;
      case 'word': {
        const fixed = ctx.fixed && ctx.fixed[node.name];
        if (fixed) return wordsOf(fixed, out, ctx);
        const src = varSrc(node.name, ctx);
        if (src === undefined) {
          if (out.indexOf(node.name) < 0) out.push(node.name);
          return;
        }
        const key = node.name + '::' + src;
        if (ctx.seen.has(key)) return;
        ctx.seen.add(key);
        try { wordsOf(varAst(node.name, src), out, ctx); } catch (e) { /* unparseable */ }
        return;
      }
      case 'ternary': wordsOf(node.yes, out, ctx); wordsOf(node.no, out, ctx); return;
      case 'band':
        node.arms.forEach((a) => wordsOf(a.then, out, ctx));
        wordsOf(node.otherwise, out, ctx);
        return;
      case 'paren': wordsOf(node.v, out, ctx); return;
      case 'set': case 'rep': case 'custom':
        node.items.forEach((i) => wordsOf(i, out, ctx));
        return;
    }
  }

  /* Interval arithmetic over the same tree. null means "cannot say" — an
     exploding die has no ceiling worth quoting, and a word has no number. */
  const span = (a, b) => ({ min: Math.min(a, b), max: Math.max(a, b) });
  function pair(l, r, f) {
    if (!l || !r) return null;
    const c = [f(l.min, r.min), f(l.min, r.max), f(l.max, r.min), f(l.max, r.max)];
    if (c.some((x) => !isFinite(x))) return null;
    return { min: Math.min.apply(null, c), max: Math.max.apply(null, c) };
  }

  /* What a binary operator can come to, given what each side can. Division
     needs a divisor that never touches zero; a remainder and a power are only
     pinned down when the right side is fixed. */
  function opBounds(op, l, r) {
    if (!l || !r) return null;
    if (op === '+') return pair(l, r, (x, y) => x + y);
    if (op === '-') return pair(l, r, (x, y) => x - y);
    if (op === '*') return pair(l, r, (x, y) => x * y);
    if (op === '/') return (r.min <= 0 && r.max >= 0) ? null : pair(l, r, idiv);
    if (op === '%') {
      if (r.min !== r.max || r.min <= 0 || l.min < 0) return null;
      return span(0, Math.min(r.min - 1, Math.floor(l.max)));
    }
    if (op === '^') {
      if (r.min !== r.max || r.min < 0 || l.min < 0) return null;
      return pair(l, r, (x, y) => Math.pow(x, y));
    }
    return null;
  }

  function boundsOf(node, ctx) {
    if (!node || typeof node !== 'object') return null;
    const mods = node.mods || [];
    const adv = mods.filter((m) => m.t === 'adv');
    // best or worst of several attempts still lands inside one attempt's range
    const inner = adv.length
      ? boundsOf(Object.assign({}, node, { mods: mods.filter((m) => m.t !== 'adv') }), ctx)
      : rawBounds(node, ctx);
    return inner;
  }

  function rawBounds(node, ctx) {
    const mods = node.mods || [];
    // anywhere but on dice, a map lands on members this cannot see one by one
    if (node.t !== 'dice' && mods.some((m) => m.t === 'map')) return null;
    let b = null;

    switch (node.t) {
      case 'num': b = span(node.v, node.v); break;
      case 'neg': { const v = boundsOf(node.v, ctx); b = v && span(-v.min, -v.max); break; }
      case 'paren': b = boundsOf(node.v, ctx); break;
      case 'bin':
        b = opBounds(node.op, boundsOf(node.l, ctx), boundsOf(node.r, ctx));
        break;
      case 'func': {
        const parts = node.args.map((a) => boundsOf(a, ctx));
        if (parts.some((x) => !x)) return null;
        const pick = (f) => ({ min: f.apply(null, parts.map((x) => x.min)),
                               max: f.apply(null, parts.map((x) => x.max)) });
        b = node.name === 'sum'
          ? { min: parts.reduce((t, x) => t + x.min, 0), max: parts.reduce((t, x) => t + x.max, 0) }
          : pick(node.name === 'max' ? Math.max : Math.min);
        break;
      }
      case 'set': case 'rep': {
        const parts = node.items.map((i) => boundsOf(i, ctx));
        if (parts.some((x) => !x)) return null;
        let lo = 0, hi = 0;
        for (const x of parts) { lo += x.min; hi += x.max; }
        const times = node.t === 'rep' ? constOf(node.count) : 1;
        if (times === null || !(times >= 0)) return null;
        b = span(lo * times, hi * times);
        break;
      }
      case 'custom': {
        const parts = node.items.map((i) => boundsOf(i, ctx));
        if (parts.some((x) => !x)) return null;
        b = { min: Math.min.apply(null, parts.map((x) => x.min)),
              max: Math.max.apply(null, parts.map((x) => x.max)) };
        break;
      }
      case 'ternary': {
        const y = boundsOf(node.yes, ctx), n = boundsOf(node.no, ctx);
        if (!y || !n) return null;
        b = { min: Math.min(y.min, n.min), max: Math.max(y.max, n.max) };
        break;
      }
      case 'band': {
        const parts = node.arms.map((a) => boundsOf(a.then, ctx))
          .concat([boundsOf(node.otherwise, ctx)]);
        if (parts.some((x) => !x)) return null;
        b = { min: Math.min.apply(null, parts.map((x) => x.min)),
              max: Math.max.apply(null, parts.map((x) => x.max)) };
        break;
      }
      case 'word': {
        const fixed = ctx.fixed && ctx.fixed[node.name];
        if (fixed) return boundsOf(fixed, ctx);
        const src = varSrc(node.name, ctx);
        if (src === undefined) return null;              // a plain word has no number
        const key = 'b' + node.name + '::' + src;
        if (ctx.seen.has(key)) return null;
        ctx.seen.add(key);
        try { b = boundsOf(varAst(node.name, src), ctx); } catch (e) { return null; }
        break;
      }
      case 'dice': {
        const sides = constOf(node.sides), qty = node.qty === null ? 1 : constOf(node.qty);
        if (sides === null || qty === null || !(qty >= 0) || !(sides >= 1)) return null;
        let lo = 1, hi = Math.floor(sides), n = Math.floor(qty);
        for (const m of mods) {
          if (m.t === 'explode') return null;            // no ceiling worth quoting
          if (m.nNode) return null;                      // a count that is thrown, not written
          if (m.t === 'min') lo = Math.max(lo, m.n);
          if (m.t === 'max') hi = Math.min(hi, m.n);
          if (m.t === 'keep') n = Math.min(n, m.n);
          if (m.t === 'drop') n = Math.max(0, n - m.n);
        }
        if (hi < lo) hi = lo;
        // a map rewrites each face, so it lands before the faces are added up
        let face = span(lo, hi);
        for (const m of mods) {
          if (m.t !== 'map') continue;
          face = opBounds(m.op, face, boundsOf(m.r, ctx));
          if (!face) return null;
        }
        b = span(n * face.min, n * face.max);
        break;
      }
      default: return null;
    }

    // a check replaces the number with a count of hits
    const chk = mods.filter((m) => m.t === 'check').pop();
    if (chk) {
      if (!CHECKS[chk.check].castable) return null;
      const n = node.t === 'dice' && node.qty !== null ? constOf(node.qty) : 1;
      return (n === null || !(n >= 0)) ? null : span(0, Math.floor(n));
    }
    return b;
  }

  /** what the whole expression could produce, without rolling anything */
  function outcomes(input) {
    const p = parse(input);
    const ctx = { vars: p.vars, fixed: p.fixed, seen: new Set() };
    const words = [];
    for (const part of p.rolls) wordsOf(part.ast, words, ctx);

    let lo = 0, hi = 0, numeric = true;
    for (const part of p.rolls) {
      const b = boundsOf(part.ast, { vars: p.vars, fixed: p.fixed, seen: new Set() });
      if (!b) { numeric = false; break; }
      lo += b.min; hi += b.max;
    }
    const reps = p.repeatNode ? constOf(p.repeatNode) : Math.max(1, p.repeat);
    return {
      words,
      min: (numeric && reps !== null) ? lo * reps : null,
      max: (numeric && reps !== null) ? hi * reps : null
    };
  }

  /* A roll that lands on a word has no total, so the run counts words instead
     of summing them. Both may happen in the same expression. */
  /* A run that can be added to. The expression is parsed once and then thrown
     as often as asked, so a chart can be filled in a few short bursts rather
     than in one stretch long enough to be felt. */
  function sampler(input) {
    const p = parse(input);
    const can = outcomes(input);
    const totals = [];
    const tally = {};
    for (const w of can.words) tally[w] = 0;
    let n = 0;

    function run(k) {
      for (let i = 0; i < k; i++) {
        let t = 0, word = null;
        for (let r = 0; r < p.repeat; r++) {
          const ctx = rollCtx(p);
          for (const part of p.rolls) {
            const v = evalNode(part.ast, ctx);
            try { t += v.total(); }
            catch (e) { word = wordText(v) || word; }
          }
        }
        if (word !== null) tally[word] = (tally[word] || 0) + 1;
        else totals.push(t);
        n++;
      }
    }

    function stats() {
      const out = {
        n, totals, tally,
        words: can.words.concat(Object.keys(tally).filter((w) => can.words.indexOf(w) < 0)),
        canMin: can.min, canMax: can.max
      };
      if (!totals.length) return Object.assign(out, { numeric: 0 });

      let sum = 0, min = Infinity, max = -Infinity;
      for (const t of totals) { sum += t; if (t < min) min = t; if (t > max) max = t; }
      const mean = sum / totals.length;
      let varsum = 0;
      for (const t of totals) varsum += (t - mean) * (t - mean);
      const sorted = totals.slice().sort((a, b) => a - b);
      const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
      return Object.assign(out, {
        numeric: totals.length, min, max, mean, stdev: Math.sqrt(varsum / totals.length),
        median: at(0.5), p10: at(0.10), p25: at(0.25), p75: at(0.75), p90: at(0.90)
      });
    }

    return { run, stats, count() { return n; } };
  }

  function runOne(input, n) {
    const s = sampler(input);
    s.run(n);
    return s.stats();
  }

  /* `3d10` produces three values, all of them a d10; `4(x),d10,d10` produces
     six, of two kinds. Summarising the sum alone hides which is which, so the
     run is broken into the smallest repeated piece — but only where the pieces
     are independent. Keep or drop couples them, and then only the whole is
     worth reporting. */
  const bracketed = (n) =>
    (n.t === 'bin' || n.t === 'neg' || n.t === 'ternary' || n.t === 'band' || n.t === 'set')
      ? { t: 'paren', v: n, mods: [] } : n;

  function unitNode(node) {
    const mods = node.mods || [];
    const coupled = mods.some((m) => {
      const k = MODS[m.t === 'check' ? 'check' : m.t];
      return k && (k.kind === 'set' || k.kind === 'repeat');
    });
    if (!coupled) {
      if (node.t === 'rep' && node.items.length === 1) {
        const n = constOf(node.count);
        // the brackets belonged to the repeat, so a compound item needs its own
        if (n !== null && n >= 1) return { node: bracketed(node.items[0]), times: n };
      }
      if (node.t === 'dice' && node.qty !== null) {
        const n = constOf(node.qty);
        if (n !== null && n >= 1) return { node: Object.assign({}, node, { qty: null }), times: n };
      }
      /* a choice distributes, so a choice about many things is many choices
         about one — ask the same question of a single member instead */
      const key = node.t === 'band' ? 'subject' : (node.t === 'ternary' ? 'cond' : null);
      if (key) {
        const sub = unitNode(node[key]);
        if (sub.times > 1) {
          const one = Object.assign({}, node);
          one[key] = sub.node;
          return { node: one, times: sub.times };
        }
      }
    }
    return { node, times: 1 };
  }
  const unitOf = (node) => {
    const u = unitNode(node);
    return { src: plain(u.node), times: u.times };
  };

  /* A study is the plan for a chart: which sub-expressions are worth reporting
     on, the exact answer for each where there is one, and a sampler for each
     that can be filled in as slowly as the screen needs. Nothing is thrown
     until `run` is called, so building one is cheap. */
  function study(input) {
    const p = parse(input);

    // a binding rolled once cannot be taken apart without changing what it means
    const preamble = p.parts.filter((x) => x.assign && !x.once)
      .map((x) => x.assign + ':=' + x.src).join(', ');
    // a repeat thrown afresh gives no fixed number of units to report on
    const splittable = !p.parts.some((x) => x.assign && x.once) && !p.repeatNode;

    const units = [];
    if (splittable) {
      for (const part of p.rolls) {
        const u = unitOf(part.ast);
        const at = units.findIndex((x) => x.src === u.src);
        if (at >= 0) units[at].times += u.times * p.repeat;
        else units.push({ src: u.src, times: u.times * p.repeat });
      }
    }
    const many = units.reduce((a, u) => a + u.times, 0) > 1 || units.length > 1;

    const open = (src) => {
      let sam = null, exact = null;
      try { sam = sampler(src); } catch (e) { return null; }
      try { exact = distribution(src); } catch (e) { exact = null; }
      return { sam, exact };
    };

    const sections = [];
    for (const u of (many ? units : [])) {
      const src = preamble ? preamble + ', ' + u.src : u.src;
      const o = open(src);
      if (o) sections.push({ title: u.src, src, times: u.times, sam: o.sam, exact: o.exact });
    }
    const w = open(input);
    // the sum is only news when there was more than one thing to add up
    if (w && (many || !sections.length)) {
      sections.push({ title: sections.length ? 'total' : null, src: input,
                      times: 1, whole: true, sam: w.sam, exact: w.exact });
    }

    function run(k) { for (const sec of sections) sec.sam.run(k); }
    function count() { return sections.length ? sections[0].sam.count() : 0; }

    function snapshot() {
      const out = sections.map((sec) =>
        Object.assign({ title: sec.title, src: sec.src, times: sec.times,
                        whole: !!sec.whole, exact: sec.exact }, sec.sam.stats()));
      const groups = out.filter((x) => !x.whole);
      const whole = out.find((x) => x.whole);

      /* The whole result is one value per unit, so what it can be is every way
         of choosing one from each — `2(band)` over four words is sixteen, not
         four. That multiplies out fast, so past a point it is left to what the
         run actually turned up. */
      if (whole) {
        const lists = [];
        for (const g of groups) {
          if (!g.words.length) continue;
          for (let i = 0; i < g.times; i++) lists.push(g.words);
        }
        const size = lists.reduce((a, l) => a * l.length, 1);
        if (lists.length && size <= LIMIT.combos) {
          let combos = [''];
          for (const l of lists) {
            const next = [];
            for (const head of combos) for (const x of l) next.push(head ? head + ', ' + x : x);
            combos = next;
          }
          whole.words = combos;
          const tally = {};
          for (const c of combos) tally[c] = whole.tally[c] || 0;
          whole.tally = tally;
        } else if (lists.length) {
          // too many to name, so report the ones that happened, commonest first
          whole.words = Object.keys(whole.tally)
            .sort((a, b) => whole.tally[b] - whole.tally[a]).slice(0, LIMIT.combos);
        }
      }
      return { notation: p.notation, sections: out };
    }

    return { notation: p.notation, run, count, snapshot, sections };
  }

  /** the old shape: build a study, run it all at once, and read it off */
  function analyse(input, n) {
    const st = study(input);
    st.run(n || 20000);
    const snap = st.snapshot();
    const whole = snap.sections.find((x) => x.whole);
    const groups = snap.sections.filter((x) => !x.whole);
    return Object.assign({}, whole || { words: [], tally: {}, numeric: 0, n: n || 20000 }, {
      notation: snap.notation, groups, showWhole: !!whole
    });
  }

  /* ==========================================================================
     WHAT AN EXPRESSION COMES TO, EXACTLY
     A simulation only ever approaches the answer. Where the shape of an
     expression allows it, the answer can be worked out instead: every value it
     can reach and how likely each one is.

     A distribution is a Map from value to probability. `null` at any point
     means "cannot say", and it travels all the way out — a partial answer
     would be worse than none, since the chart would quietly stop being true.
     Three things force it: a dependence the arithmetic cannot see (a `::=`
     binding, a choice about the same roll), an unbounded support (an exploding
     die), and sheer size (the caps below).
     ========================================================================== */
  const DLIM = { vals: 30000, pairs: 2000000, multisets: 400000, dice: 400 };

  const dOne = (v) => new Map([[v, 1]]);

  /* A count or a number of sides may be written as a variable rather than
     typed. Anything that comes to exactly one value is as good as a constant
     here, which is what lets a pool written as (pool)d10 be worked out. */
  /** a modifier's count, when it is a number the solver can rely on */
  function staticCount(m, ctx, key) {
    const k = key || 'n';
    if (!m[k + 'Node']) return m[k];
    const v = constVal(m[k + 'Node'], ctx);
    return v === null ? null : Math.floor(v);
  }

  function constVal(node, ctx) {
    const c = constOf(node);
    if (c !== null) return c;
    const d = distOf(node, ctx);
    if (!d || d.size !== 1) return null;
    return d.keys().next().value;
  }

  /** every pair of one distribution with another, combined by f */
  function dPair(a, b, f) {
    if (!a || !b) return null;
    if (a.size * b.size > DLIM.pairs) return null;
    const out = new Map();
    for (const [x, px] of a) {
      for (const [y, py] of b) {
        const v = f(x, y);
        if (!isFinite(v)) return null;
        out.set(v, (out.get(v) || 0) + px * py);
      }
    }
    return out.size > DLIM.vals ? null : out;
  }

  /** the sum of n independent copies, by repeated squaring */
  function dPower(d, n) {
    if (!d || !(n >= 0)) return null;
    let out = dOne(0), base = d, k = Math.floor(n);
    while (k > 0) {
      if (k & 1) { out = dPair(out, base, (x, y) => x + y); if (!out) return null; }
      k >>= 1;
      if (k) { base = dPair(base, base, (x, y) => x + y); if (!base) return null; }
    }
    return out;
  }

  /** weighted mixture, for a custom die and for a variable read more than once */
  function dMix(parts, weights) {
    const out = new Map();
    parts.forEach((d, i) => {
      if (!d) return;
      for (const [v, p] of d) out.set(v, (out.get(v) || 0) + p * weights[i]);
    });
    return (parts.some((d) => !d) || out.size > DLIM.vals) ? null : out;
  }

  /* ------------------------------------------------------------ one die
     The faces of a single die once everything that acts on a face alone has
     been applied. A re-roll is exact both ways round: once over, the old face
     hands its weight to a fresh throw; repeated, the qualifying faces simply
     cannot be where it stops, so what is left is renormalised. */
  function faceDist(node, ctx, single) {
    const sides = constVal(node.sides, ctx);
    if (sides === null || !(sides >= 1) || sides > 4096) return null;
    const n = Math.floor(sides);
    let faces = new Map();
    for (let f = 1; f <= n; f++) faces.set(f, 1 / n);

    const mods = (node.mods || []).slice()
      .sort((a, b) => (MODS[a.t === 'check' ? 'check' : a.t] || { order: 99 }).order -
                      (MODS[b.t === 'check' ? 'check' : b.t] || { order: 99 }).order);

    for (const m of mods) {
      if (m.t === 'explode' || m.t === 'unique') return null;   // no ceiling, or coupled
      // a lone die is its own total, so there the two readings agree
      if (!m.each && !single && (m.t === 'min' || m.t === 'max')) continue;
      if (!m.each && !single && m.t === 'reroll') continue;
      if (m.t === 'min' || m.t === 'max') {
        const n = staticCount(m, ctx);
        if (n === null || n === undefined) return null;
        const out = new Map();
        for (const [f, p] of faces) {
          const v = m.t === 'min' ? Math.max(f, n) : Math.min(f, n);
          out.set(v, (out.get(v) || 0) + p);
        }
        faces = out;
        continue;
      }
      if (m.t === 'reroll') {
        const cp = m.cp || { op: '=', v: 1 };
        const hits = (f) => { const r = cpConst(cp, f); return r === null ? null : r; };
        let bad = 0;
        for (const [f, p] of faces) {
          const h = hits(f);
          if (h === null) return null;
          if (h) bad += p;
        }
        if (bad >= 1) return null;                     // nothing left to land on
        const out = new Map();
        for (const [f, p] of faces) {
          const h = hits(f);
          // once over: the old face keeps its weight and passes on the rest
          const kept = h ? 0 : p;
          out.set(f, (out.get(f) || 0) + (m.inf ? kept / (1 - bad) : kept + bad * p));
        }
        faces = out;
        continue;
      }
      if (m.t === 'map') {
        const r = distOf(m.r, ctx);
        const out = dPair(faces, r, (x, y) => arith(m.op, x, y, m.opSp));
        if (!out) return null;
        faces = out;
        continue;
      }
      if (m.t === 'keep' || m.t === 'drop' || m.t === 'check' || m.t === 'adv') continue;
      return null;
    }
    return faces;
  }

  /** a comparison against a fixed face, when the other side is a plain number */
  function cpConst(cp, v) {
    if (cp.node) {
      const c = constOf(cp.node);
      return c === null ? null : compare(cp.op, v, c);
    }
    return compare(cp.op, v, cp.v);
  }

  /* Keeping or dropping couples the dice, so they have to be looked at
     together: every multiset of n faces, weighted by how many orders produce
     it. That count grows quickly, which is what the cap is for. */
  function keptSumDist(faces, n, keep) {
    const vals = Array.from(faces.keys()).sort((a, b) => a - b);
    const probs = vals.map((v) => faces.get(v));
    const F = vals.length;
    // C(n + F - 1, F - 1) multisets; refuse before building any of them
    let count = 1;
    for (let i = 1; i <= F - 1; i++) count = count * (n + i) / i;
    if (!(count <= DLIM.multisets)) return null;

    // log factorials, so the multinomial coefficient never overflows
    const lf = [0];
    for (let i = 1; i <= n; i++) lf.push(lf[i - 1] + Math.log(i));

    const out = new Map();
    const counts = new Array(F).fill(0);
    (function place(i, left) {
      if (i === F - 1) {
        counts[i] = left;
        let logw = lf[n], sum = 0, taken = 0;
        for (let k = 0; k < F; k++) {
          logw -= lf[counts[k]];
          logw += counts[k] * Math.log(probs[k]);
        }
        // the kept ones, taken from whichever end the modifier asks for
        for (let k = F - 1; k >= 0 && taken < keep.n; k--) {
          const idx = keep.high ? k : F - 1 - k;
          const c = counts[idx], take = Math.min(c, keep.n - taken);
          sum += vals[idx] * take;
          taken += take;
        }
        const w = Math.exp(logw);
        if (w > 0) out.set(sum, (out.get(sum) || 0) + w);
        return;
      }
      for (let c = 0; c <= left; c++) { counts[i] = c; place(i + 1, left - c); }
    }(0, n));
    return out.size > DLIM.vals ? null : out;
  }

  /* ------------------------------------------------- a whole dice term */
  function diceDist(node, ctx) {
    const qty = node.qty === null ? 1 : constVal(node.qty, ctx);
    if (qty === null || !(qty >= 0) || qty > DLIM.dice) return null;
    const n = Math.floor(qty);
    const single = node.qty === null;
    const faces = faceDist(node, ctx, single);
    if (!faces) return null;

    const mods = node.mods || [];
    const chk = mods.filter((m) => m.t === 'check').pop();
    const keepMod = mods.filter((m) => m.t === 'keep' || m.t === 'drop').pop();
    if (mods.filter((m) => m.t === 'keep' || m.t === 'drop').length > 1) return null;

    if (chk && (chk.each || single)) {
      // a check counts hits, and hits are independent, so this is binomial
      if (!CHECKS[chk.check].castable) return null;
      if (keepMod) return null;                    // keeping first changes what is counted
      let p = 0;
      for (const [f, q] of faces) {
        const h = cpConst(chk.cp, f);
        if (h === null) return null;
        if (h) p += q;
      }
      const out = new Map();
      let term = Math.pow(1 - p, n);
      for (let k = 0; k <= n; k++) {
        out.set(k, term);
        if (k < n) term = term * (n - k) / (k + 1) * (p / (1 - p));
        if (!isFinite(term)) return p === 1 ? dOne(n) : null;
      }
      return out;
    }

    let sum;
    if (keepMod) {
      if (node.qty === null) return null;          // nothing to keep from
      const kn = staticCount(keepMod, ctx);
      if (kn === null || kn === undefined) return null;
      const want = keepMod.t === 'keep' ? kn : n - kn;
      const high = keepMod.t === 'keep' ? keepMod.end === 'h' : keepMod.end === 'l';
      if (!(want >= 0)) return null;
      sum = keptSumDist(faces, n, { n: Math.min(want, n), high });
    } else {
      sum = single ? faces : dPower(faces, n);
    }
    // and then whatever the term's own total is put through
    return totalMods(sum, node, ctx, n);
  }

  /* ------------------------------------------------------- the whole tree */
  function distOf(node, ctx) {
    if (!node || typeof node !== 'object') return null;
    const mods = node.mods || [];

    /* Exploding or re-rolling a whole term is about its total, so it is exact
       from that total's own distribution. An unbounded explode is the one that
       has nothing exact to say. */
    const term = mods.find((m) => aboutTerm(node, m));
    if (term) {
      const inner = distOf(Object.assign({}, node, { mods: mods.filter((m) => m !== term) }), ctx);
      if (!inner) return null;
      let cp = term.cp;
      if (!cp) {
        const vals = Array.from(inner.keys());
        cp = { op: '=', v: term.t === 'explode' ? Math.max.apply(null, vals) : Math.min.apply(null, vals) };
      } else if (cp.node && constOf(cp.node) === null) return null;
      if (term.t === 'reroll') return rerollDist(inner, cp, term.inf, ctx);
      return term.inf ? null : explodeDist(inner, cp, term.pen, ctx);
    }

    /* Advantage rolls the term again and keeps the best or worst total, so it
       is the extreme of n independent copies — exact from the running sum. */
    const adv = mods.find((m) => m.t === 'adv');
    if (adv) {
      const inner = distOf(Object.assign({}, node, { mods: mods.filter((m) => m !== adv) }), ctx);
      if (!inner) return null;
      const an = staticCount(adv, ctx);
      if (an === null || an === undefined || !(an >= 1)) return null;
      const vals = Array.from(inner.keys()).sort((a, b) => a - b);
      const out = new Map();
      let below = 0;
      for (const v of vals) {
        const p = inner.get(v), atOrBelow = below + p;
        // P(best = v) = P(all <= v) - P(all < v); the worst is the mirror image
        out.set(v, adv.end === 'h'
          ? Math.pow(atOrBelow, an) - Math.pow(below, an)
          : Math.pow(1 - below, an) - Math.pow(1 - atOrBelow, an));
        below = atOrBelow;
      }
      return out;
    }

    switch (node.t) {
      case 'num': return dOne(node.v);
      case 'neg': { const d = distOf(node.v, ctx); return d && dPair(d, dOne(0), (x) => -x); }
      case 'paren': return withMods(distOf(node.v, ctx), node, ctx);
      case 'bin': return dPair(distOf(node.l, ctx), distOf(node.r, ctx),
        (x, y) => arith(node.op, x, y, node.opSp));
      case 'func': {
        const f = FUNCS[node.name];
        let acc = distOf(node.args[0], ctx);
        for (let i = 1; i < node.args.length; i++) {
          acc = dPair(acc, distOf(node.args[i], ctx), (x, y) => f(x, y));
        }
        return withMods(acc, node, ctx);
      }
      case 'dice': return diceDist(node, ctx);
      case 'custom': {
        const parts = node.items.map((i) => distOf(i, ctx));
        const w = node.items.map(() => 1 / node.items.length);
        return withMods(dMix(parts, w), node, ctx);
      }
      case 'set': case 'rep': {
        let acc = dOne(0);
        for (const it of node.items) {
          acc = dPair(acc, distOf(it, ctx), (x, y) => x + y);
          if (!acc) return null;
        }
        if (node.t === 'rep') {
          const times = constVal(node.count, ctx);
          if (times === null || !(times >= 0) || times > DLIM.dice) return null;
          acc = dPower(acc, times);
        }
        return withMods(acc, node, ctx);
      }
      case 'word': {
        if (ctx.fixed && ctx.fixed[node.name]) return null;   // one roll, read twice
        const src = varSrc(node.name, ctx);
        if (src === undefined) return null;                   // a word carries no number
        if (ctx.depth >= LIMIT.varDepth) return null;
        let ast;
        try { ast = varAst(node.name, src); } catch (e) { return null; }
        ctx.depth++;
        const d = distOf(ast, ctx);
        ctx.depth--;
        return withMods(d, node, ctx, isSet(ast));
      }
    }
    return null;
  }

  /* Modifiers on anything that is not a dice term. A distribution is one
     number at a time, so it cannot see the members of a set — and a check, a
     map and a clamp all act on each member. On a set, then, there is nothing
     to say; only a single value can be answered for.

     A clamp is the odd one out even there: min and max only ever move a die
     face, and by the time a value has been bracketed or named there is no face
     left to move, so they do nothing at all. */
  function withMods(d, node, ctx, set) {
    if (!d) return null;
    const mods = node.mods || [];
    if (!mods.length) return d;
    if (set === undefined ? isSet(node) : set) return null;

    for (const m of mods.slice()
      .sort((a, b) => (MODS[a.t === 'check' ? 'check' : a.t] || { order: 99 }).order -
                      (MODS[b.t === 'check' ? 'check' : b.t] || { order: 99 }).order)) {
      if (m.t === 'adv') continue;                            // handled above
      if (m.each) return null;                                // members this cannot see
      if (m.t === 'map') { d = dPair(d, distOf(m.r, ctx), (x, y) => arith(m.op, x, y, m.opSp)); }
      else if (m.t === 'min' || m.t === 'max' || m.t === 'check') {
        d = totalMods(d, { mods: [m] }, ctx, 1);
      } else return null;
      if (!d) return null;
    }
    return d;
  }

  /** does any of this distribution's mass qualify, and how much */
  function cpMass(d, cp, ctx) {
    let p = 0;
    for (const [v, q] of d) {
      const hit = cpConst(cp, v);
      if (hit === null) return null;
      if (hit) p += q;
    }
    return p;
  }

  /* A clamp on a total: the mass below the floor piles up on it. */
  function clampDist(d, n, low) {
    const out = new Map();
    for (const [v, p] of d) {
      const w = low ? Math.max(v, n) : Math.min(v, n);
      out.set(w, (out.get(w) || 0) + p);
    }
    return out;
  }

  /* A term thrown again when its own total qualifies. Once over, the qualifying
     mass is replaced by a fresh throw; repeatedly, it simply cannot be where
     this stops, so what is left is renormalised. Either way it is exact. */
  function rerollDist(d, cp, inf, ctx) {
    const bad = cpMass(d, cp, ctx);
    if (bad === null || bad >= 1) return null;
    const out = new Map();
    for (const [v, p] of d) {
      const hit = cpConst(cp, v);
      const kept = hit ? 0 : p;
      out.set(v, (out.get(v) || 0) + (inf ? kept / (1 - bad) : kept + bad * p));
    }
    return out;
  }

  /* A term thrown again and added when its total qualifies. Once over this is
     a convolution over the qualifying mass; repeated, the support has no top
     and there is nothing exact to say. */
  function explodeDist(d, cp, pen, ctx) {
    const out = new Map();
    for (const [v, p] of d) {
      const hit = cpConst(cp, v);
      if (hit === null) return null;
      if (!hit) { out.set(v, (out.get(v) || 0) + p); continue; }
      for (const [w, q] of d) {
        const t = v + w - (pen ? 1 : 0);
        out.set(t, (out.get(t) || 0) + p * q);
      }
    }
    return out.size > DLIM.vals ? null : out;
  }

  /* Everything a modifier can say about a total once that total is known. The
     ones marked @ have already been folded into the faces, and keep and drop
     into the sum, so what is left here is only ever about the one number. */
  function totalMods(d, node, ctx, members) {
    const mods = (node.mods || []).slice().sort((a, b) =>
      (MODS[a.t === 'check' ? 'check' : a.t] || { order: 99 }).order -
      (MODS[b.t === 'check' ? 'check' : b.t] || { order: 99 }).order);

    for (const m of mods) {
      if (!d) return null;
      if (m.each || m.t === 'adv' || m.t === 'keep' || m.t === 'drop') continue;
      if (m.t === 'unique') return null;
      if (m.t === 'map') continue;                     // per member by definition
      if (m.t === 'min' || m.t === 'max') {
        const n = staticCount(m, ctx);
        if (n === null || n === undefined) return null;
        d = clampDist(d, n, m.t === 'min');
      } else if (m.t === 'explode' || m.t === 'reroll') {
        // handled where the term is thrown again, not here
        continue;
      } else if (m.t === 'check') {
        if (!CHECKS[m.check].castable) return null;
        const p = cpMass(d, m.cp, ctx);
        if (p === null) return null;
        d = new Map([[0, 1 - p], [1, p]]);
      } else return null;
    }
    void members;
    return d;
  }

  /** the moments and quantiles of a distribution, read straight off it */
  function summarise(pmf) {
    const vals = Array.from(pmf.keys()).sort((a, b) => a - b);
    let mean = 0, mass = 0;
    for (const v of vals) { mean += v * pmf.get(v); mass += pmf.get(v); }
    if (!(mass > 0.999 && mass < 1.001)) return null;         // it does not add up
    let varsum = 0;
    for (const v of vals) varsum += pmf.get(v) * (v - mean) * (v - mean);
    const at = (q) => {
      let acc = 0;
      for (const v of vals) { acc += pmf.get(v); if (acc >= q) return v; }
      return vals[vals.length - 1];
    };
    return {
      min: vals[0], max: vals[vals.length - 1], mean, stdev: Math.sqrt(varsum),
      median: at(0.5), p10: at(0.10), p25: at(0.25), p75: at(0.75), p90: at(0.90)
    };
  }

  /* The words a choice can land on, and how often — exact whenever the thing
     it is choosing about has a distribution of its own and is one value rather
     than a set, since then each arm is simply a slice of that distribution. */
  function armWords(node) {
    if (node.t === 'band') {
      const arms = node.arms.map((a) => ({ cp: a.cp, then: a.then }));
      arms.push({ cp: null, then: node.otherwise });
      return { subject: node.subject, arms, lead: null };
    }
    /* A plain two-way choice is the same shape with one arm, once the check
       that made the condition a condition is lifted back off it. */
    if (node.t === 'ternary') {
      const mods = node.cond.mods || [];
      const lead = mods.filter((m) => m.t === 'check').pop();
      if (!lead || !CHECKS[lead.check].castable) return null;
      return {
        subject: Object.assign({}, node.cond, { mods: mods.filter((m) => m !== lead) }),
        arms: [{ cp: lead.cp, then: node.yes }, { cp: null, then: node.no }],
        lead: lead
      };
    }
    return null;
  }

  function wordOdds(node, ctx) {
    const spec = armWords(node);
    if (!spec) return null;
    // one answer per member is a different question from one answer
    if (spec.arms.some((a) => a.each) || (spec.lead && spec.lead.each)) return null;
    if (isSet(spec.subject) && spec.arms.some((a) => a.each)) return null;
    // any check left on the subject would be counted twice
    if ((spec.subject.mods || []).some((m) => m.t === 'check')) return null;
    const d = distOf(spec.subject, ctx);
    if (!d) return null;

    const out = new Map();
    const left = new Map(d);
    for (const arm of spec.arms) {
      // a bare word is only a word while no variable of that name is set
      if (arm.then.t === 'word' && (arm.then.forced ||
          (ctx.fixed && ctx.fixed[arm.then.name]) ||
          varSrc(arm.then.name, ctx) !== undefined)) return null;
      if ((arm.then.mods || []).length) return null;
      if (arm.then.t !== 'str' && arm.then.t !== 'word') return null;
      const word = arm.then.t === 'str' ? arm.then.v : arm.then.name;
      let p = 0;
      for (const [v, q] of Array.from(left)) {
        const hit = arm.cp === null ? true : cpConst(arm.cp, v);
        if (hit === null) return null;
        if (hit) { p += q; left.delete(v); }
      }
      out.set(word, (out.get(word) || 0) + p);
    }
    return out;
  }

  /* ------------------------------------------------------------- migration
     An expression written before `@` existed meant every element modifier a
     member at a time, because that was the only reading there was. Marking
     each of those keeps it saying exactly what it always said. It is a
     mechanical rewrite, so it preserves meaning rather than taste: `4d6kh1@>=5`
     is a comparison over one member, which is the same as one over the total,
     and is left alone rather than tidied. */
  function markEach(node) {
    if (!node || typeof node !== 'object') return;
    if (isSet(node)) {
      for (const m of node.mods || []) {
        const spec = MODS[m.t === 'check' ? 'check' : m.t];
        if (spec && (spec.kind === 'element' || spec.kind === 'die')) m.each = true;
      }
    }
    if (node.t === 'band') {
      const each = isSet(node.subject);
      for (const a of node.arms) { if (each) a.each = true; markEach(a.then); }
      markEach(node.subject);
      markEach(node.otherwise);
      return;
    }
    for (const k of ['l', 'r', 'v', 'qty', 'sides', 'cond', 'yes', 'no', 'count']) markEach(node[k]);
    for (const a of node.args || []) markEach(a);
    for (const i of node.items || []) markEach(i);
    for (const m of node.mods || []) { if (m.cp && m.cp.node) markEach(m.cp.node); if (m.r) markEach(m.r); }
  }

  /** an expression from before `@`, rewritten to go on meaning what it meant */
  function migrate(input) {
    const raw = String(input == null ? '' : input);
    let p;
    try { p = parse(raw); } catch (e) { return raw; }        // leave what will not parse
    for (const part of p.parts) markEach(part.ast);
    const body = (p.repeat > 1 ? p.repeat + 'x ' : '') + p.parts.map((x) =>
      (x.assign ? x.assign + (x.once ? '::=' : ':=') : '') + plain(x.ast)).join(', ');
    return p.label ? body + ' # ' + p.label : body;
  }

  /** the exact distribution of a whole expression, or null */
  function distribution(input) {
    const p = parse(input);
    if (p.parts.some((x) => x.assign && x.once)) return null;
    const ctx = { vars: p.vars, fixed: null, depth: 0 };

    // a band over one value is words, not numbers, and has its own answer
    if (p.rolls.length === 1 && p.repeat === 1) {
      const w = wordOdds(p.rolls[0].ast, ctx);
      if (w) return { words: w, exact: true };
    }

    let acc = dOne(0);
    for (const part of p.rolls) {
      acc = dPair(acc, distOf(part.ast, ctx), (x, y) => x + y);
      if (!acc) return null;
    }
    acc = dPower(acc, p.repeat);
    if (!acc) return null;
    const stats = summarise(acc);
    return stats && Object.assign({ pmf: acc, exact: true }, stats);
  }

  global.DiceEngine = {
    parse, inspect, evaluate, roll, analyse, preview, setVars, fmt, esc, shapeFor,
    splitLabel, outcomes, distribution, study, migrate,
    DiceError, LIMIT, FUNCS, CHECKS, MARK_ORDER
  };
}(window));
