/* ============================================================================
   Random Engine — dice notation parser, evaluator & explainer
   ----------------------------------------------------------------------------
   There are exactly two structural types, and everything follows from them:

     value   a single number
     set     an ordered collection of values

   A set becomes a value by being SUMMED — that is the only implicit reduction.
   `,` builds a set, `N(expr)` repeats an expression into one, and `4d6` is
   sugar for `4(d6)`. A set inside a set unpacks, so nesting never compounds.

   Modifiers fall into three kinds:

     die       e, r                      need a die to re-roll
     element   min, max, s, f, cs, cf    apply to each member in turn
     set       kh, kl, dh, dl, u         need a collection, error on a value

   On top of numbers there are result types. `s` yields a success check whose
   members read as success/failure and cast to 1/0, so it can be used in
   arithmetic. `f`, `cs` and `cf` yield checks that carry no number and cannot
   be cast — using one as an operand is rejected before the roll happens.

     expr    := term (('+' | '-') term)*
     term    := power (('*' | '/' | '%') power)*
     power   := unary (('^' | '**') power)?
     unary   := ('-' | '+')? primary
     primary := number ['(' list ')' | 'd' sides] modifier*
              | '(' list ')' modifier*
              | func '(' list ')'
              | 'd' sides modifier*
     list    := expr (',' expr)*
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
    check: { kind: 'element', order: 8 }
  };

  /* the four checks. only `s` carries a number through to arithmetic */
  const CHECKS = {
    s: { castable: true, hit: 'success', miss: 'failure', label: 'Success check' },
    f: { castable: false, hit: 'failure', miss: null, label: 'Failure check' },
    cs: { castable: false, hit: 'critSuccess', miss: null, label: 'Critical success' },
    cf: { castable: false, hit: 'critFail', miss: null, label: 'Critical failure' }
  };

  class DiceError extends Error {
    constructor(msg, pos) { super(msg); this.name = 'DiceError'; this.pos = pos; }
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => !isFinite(n) ? String(n)
    : (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
  const cpText = (cp) => cp ? cp.op + cp.v : '';

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

    /** cond ? a : b — the condition has to read as success or failure */
    expr() {
      const cond = this.sum();
      const q = this.mark();
      if (!this.lit('?')) return cond;
      const yes = this.expr();
      const cA = this.mark();
      if (!this.lit(':')) this.fail('expected ":" to finish the ? : choice');
      const no = this.expr();
      return {
        t: 'ternary', cond, yes, no, uid: ++this.uid,
        qSp: [q, q + 1], cSp: [cA, cA + 1], sp: [cond.sp ? cond.sp[0] : q, this.i]
      };
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
        if (this.s.substr(this.i, op.length) === op) {
          const save = this.i;
          this.i += op.length;
          const v = this.signedInt();
          if (v === null) { this.i = save; return null; }
          return { op: op === '<>' ? '!=' : op, v };
        }
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
      case 'ternary':
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
  function cpTest(cp, v) {
    switch (cp.op) {
      case '=': return v === cp.v;
      case '!=': return v !== cp.v;
      case '<': return v < cp.v;
      case '>': return v > cp.v;
      case '<=': return v <= cp.v;
      case '>=': return v >= cp.v;
    }
    return false;
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
    const c = CHECKS[item.check.kind];
    return item.check.hit ? c.hit : c.miss;
  }

  function checkTotal(item) {
    const c = item.check;
    if (!c) return null;
    if (!CHECKS[c.kind].castable) {
      throw new DiceError('a ' + CHECKS[c.kind].label.toLowerCase() + ' cannot be used as a number');
    }
    return c.hit ? 1 : 0;
  }

  function markClass(item) {
    if (!item.check) return '';
    const c = CHECKS[item.check.kind];
    return item.check.hit ? ' ' + c.hit : (c.miss ? ' ' + c.miss : '');
  }

  /** totals throw on a non-castable check; the display must not. raw() is the
      underlying number, which never consults the check, so there is no loop. */
  function safeTotal(node) {
    try { return node.total(); } catch (e) { return node.raw(); }
  }

  function Die(roll, sides, uid) {
    return {
      set: false, die: true, roll, sides, uid, check: null,
      get dropped() { return !!roll.dropped; },
      set dropped(v) { roll.dropped = v; },
      get value() { return roll.v; },
      raw() { return roll.v; },
      total() { const c = checkTotal(this); return c === null ? roll.v : c; },
      html(o) {
        const tag = uid ? ' data-x="d' + uid + '"' : '';
        return (o && o.plain) ? chipHTML(this, tag) : dieHTML(this, shapeFor(sides), tag);
      }
    };
  }

  /** a word: 'success', 'failure', or anything the user quoted */
  function Str(word, html) {
    return {
      set: false, die: false, word, check: null, dropped: false,
      get value() { return word; },
      raw() { return 0; },
      total() {
        throw new DiceError('"' + word + '" is a word, not a number, ' +
          'so it cannot be used in a calculation');
      },
      html() { return html || '<span class="r-str">' + esc(word) + '</span>'; }
    };
  }

  function Val(v, html) {
    return {
      set: false, die: false, check: null, dropped: false,
      get value() { return v; },
      raw() { return v; },
      total() { const c = checkTotal(this); return c === null ? v : c; },
      html() { return html || '<span class="r-num">' + fmt(v) + '</span>'; }
    };
  }

  /** a bracket around a value: still a value, drawn with its own subtotal */
  function Group(inner, uid, prefix) {
    return {
      set: false, die: false, check: null, dropped: false, uid,
      get value() { return inner.word !== undefined ? inner.word : inner.raw(); },
      get word() { return inner.word; },
      raw() { return inner.raw(); },
      total() { const c = checkTotal(this); return c === null ? inner.total() : c; },
      html(o) {
        const tag = uid ? ' data-x="s' + uid + '"' : '';
        const sum = inner.word !== undefined ? '' : ' data-sum="' + esc(fmt(safeTotal(inner))) + '"';
        return '<span class="r-grp"' + tag + sum + '>' + (prefix || '') +
          '<span class="r-brk"' + tag + '>(</span>' + inner.html(o) +
          '<span class="r-brk"' + tag + '>)</span></span>';
      }
    };
  }

  /** a face picked off a custom die, drawn as the die it came from */
  function CustomDie(inner, shape, uid) {
    return {
      set: false, die: false, custom: true, check: null, dropped: false, uid,
      get value() { return inner.word !== undefined ? inner.word : inner.raw(); },
      get word() { return inner.word; },
      raw() { return inner.raw(); },
      total() { const c = checkTotal(this); return c === null ? inner.total() : c; },
      html(o) {
        const tag = uid ? ' data-x="c' + uid + '"' : '';
        const w = wordOf(this);
        const face = w !== null && w !== undefined ? w
          : (inner.word !== undefined ? inner.word : fmt(safeTotal(inner)));
        const cls = ['die', 'custom', 's-' + shape];
        const mk = markClass(this);
        if (mk) cls.push(mk.trim());
        const size = String(face).length >= 3 ? ' v3' : (String(face).length === 2 ? ' v2' : '');
        return '<span class="' + cls.join(' ') + '"' + tag + ' title="custom die">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
          '<use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval' + size + '">' + esc(String(face)) + '</span></span>';
      }
    };
  }

  /* ------------------------------------------------------------ variables */
  let VARS = {};
  const varCache = new Map();

  function varAst(name, src) {
    const key = name + '::' + src;
    if (!varCache.has(key)) varCache.set(key, new Parser(String(src)).parse());
    return varCache.get(key);
  }

  const varTag = (node) => '<span class="r-var">' + esc(node.name) + '</span>';

  function setVars(map) {
    VARS = {};
    for (const k in map) if (/^[a-zA-Z_]+$/.test(k)) VARS[k] = map[k];
    varCache.clear();
  }

  /** success is true, failure is false, anything else is not a condition */
  function truth(v) {
    const w = v.word !== undefined ? v.word : wordOf(v);
    if (w === 'success') return true;
    if (w === 'failure') return false;
    throw new DiceError('a ? : choice needs a success or failure on the left — ' +
      'compare something first, like d20>=15 ? hit : miss');
  }

  function SetVal(members, opts) {
    opts = opts || {};
    return {
      set: true, members, check: null, dropped: false, uid: opts.uid,
      brackets: !!opts.brackets, prefix: opts.prefix || '',
      get value() { return this.raw(); },
      raw() { let s = 0; for (const m of members) if (!m.dropped) s += m.raw(); return s; },
      live() { return members.filter((m) => !m.dropped); },
      total() {
        const c = checkTotal(this);
        if (c !== null) return c;
        let s = 0;
        for (const m of this.live()) s += m.total();
        return s;
      },
      marks() {
        const out = {};
        const add = (k) => { if (k) out[k] = (out[k] || 0) + 1; };
        for (const m of this.live()) {
          if (m.check) {
            const c = CHECKS[m.check.kind];
            add(m.check.hit ? c.hit : c.miss);
          } else if (m.set && m.marks) {
            const sub = m.marks();
            if (sub) for (const k in sub) out[k] = (out[k] || 0) + sub[k];
          }
        }
        return Object.keys(out).length ? out : null;
      },
      html(o) {
        const tag = this.uid ? ' data-x="' + (this.brackets ? 's' : 'd') + this.uid + '"' : '';
        const sum = ' data-sum="' + esc(fmt(safeTotal(this))) + '"';
        if (this.brackets) {
          return '<span class="r-grp"' + tag + sum + '>' + this.prefix +
            '<span class="r-brk"' + tag + '>(</span>' +
            members.map((m) => m.html(o)).join('<span class="r-op">,</span>') +
            '<span class="r-brk"' + tag + '>)</span></span>';
        }
        const squeezed = members.length > SQUEEZE_AT && members.every((m) => m.die);
        const body = members.map((m) => m.html(o)).join(squeezed ? '' : PLUS);
        return '<span class="r-term' + (squeezed ? ' squeezed' : '') + '"' + tag +
          (members.length > 1 ? sum : '') + squeezeStyle(members.length) + '>' + body + '</span>';
      }
    };
  }

  /* ------------------------------------------------------------- markup */
  function dieHTML(item, shape, tag) {
    const r = item.roll;
    const cls = ['die', 's-' + shape].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const mk = markClass(item);
    if (mk) cls.push(mk.trim());
    const face = fmt(r.v);
    const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');
    let badge = '';
    if (r.from !== null && r.from !== undefined) badge = '<s>' + esc(fmt(r.from)) + '</s>';
    else if (r.tags.indexOf('exploded') >= 0) badge = '!';
    const title = (r.tags.length ? r.tags.join(', ') : 'natural') +
      (r.dropped ? ', dropped' : '') + (mk ? ',' + mk : '');
    return '<span class="' + cls.join(' ') + '"' + tag + ' title="' + esc(title) + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + esc(face) + '</span>' +
      (badge ? '<span class="diebadge">' + badge + '</span>' : '') + '</span>';
  }

  function chipHTML(item, tag) {
    const r = item.roll;
    const cls = ['chip-die'].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const mk = markClass(item);
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
          while (cpTest(cp, last) && n < LIMIT.explode) {
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
          while (cpTest(cp, r.v) && n < LIMIT.reroll) {
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

  function eachMember(value, fn) {
    if (value.set) { for (const m of value.members) fn(m); } else fn(value);
  }

  function applyElement(item, m) {
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
      item.check = { kind: m.check, hit: cpTest(m.cp, item.value) };
    }
  }

  function applySet(value, m, sides) {
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
        while (seen.has(x.roll.v) && (!m.cp || cpTest(m.cp, x.roll.v)) && n < cap) {
          if (x.roll.from === null) x.roll.from = x.roll.v;
          x.roll.v = makeDie(sides);
          if (x.roll.tags.indexOf('rerolled') < 0) x.roll.tags.push('rerolled');
          n++;
        }
        seen.add(x.roll.v);
      }
    }
  }

  function applyMods(value, mods, sides) {
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
      if (kind === 'element') eachMember(value, (item) => applyElement(item, m));
      else applySet(value, m, sides);
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

    const dice = rolls.map((r) => Die(r, sides, node.uid));
    // a bare d6 is one value; 4d6 is a set of four
    const value = single ? dice[0] : SetVal(dice, { uid: node.uid });
    return applyMods(value, node.mods, sides);
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

  function evalNode(node, ctx) {
    switch (node.t) {
      case 'num': return Val(node.v);

      case 'str': return applyMods(Str(node.v), node.mods || [], null);

      /* a bare word is a variable when one is defined, otherwise just a word */
      case 'word': {
        const src = VARS[node.name];
        if (src === undefined) {
          if (node.forced) throw new DiceError('no variable named "' + node.name + '" is set');
          return applyMods(Str(node.name), node.mods || [], null);
        }
        if (ctx.depth >= LIMIT.varDepth) {
          throw new DiceError('variable "' + node.name + '" keeps referring back to itself');
        }
        let ast;
        try { ast = varAst(node.name, src); }
        catch (e) { throw new DiceError('variable "' + node.name + '": ' + e.message); }
        ctx.depth++;
        const v = evalNode(ast, ctx);
        ctx.depth--;
        const wrapped = v.set
          ? SetVal(v.members, { uid: node.uid, brackets: true, prefix: varTag(node) })
          : Group(v, node.uid, varTag(node));
        return applyMods(wrapped, node.mods || [], null);
      }

      /* one face is picked, then whatever is written on it is evaluated */
      case 'custom': {
        const pick = node.items[rng.int(0, node.items.length - 1)];
        const v = evalNode(pick, ctx);
        const shape = shapeFor(node.items.length);
        return applyMods(CustomDie(v, shape, node.uid), node.mods || [], null);
      }

      case 'ternary': {
        const c = evalNode(node.cond, ctx);
        const branch = truth(c) ? node.yes : node.no;
        const v = evalNode(branch, ctx);
        const tag = node.uid ? ' data-x="t' + node.uid + '"' : '';
        return Group(v, node.uid, '<span class="r-cond"' + tag + '>' + c.html() + '<span class="r-op">?</span></span>');
      }

      case 'neg': {
        const v = evalNode(node.v, ctx);
        if (v.set) {
          // a minus in front of a set flips every member
          return SetVal(v.members.map((m) =>
            Val(-safeTotal(m), '<span class="r-op">-</span>' + m.html())), { uid: node.uid });
        }
        return Val(-v.total(), '<span class="r-op">-</span>' + v.html());
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
        const tag = node.uid ? ' data-x="o' + node.uid + '"' : '';
        return Val(v, l.html() + '<span class="r-op"' + tag + '>' + esc(node.op) + '</span>' + r.html());
      }

      case 'func': {
        const parts = node.args.map((a) => evalNode(a, ctx));
        const v = FUNCS[node.name].apply(null, parts.map((p) => p.total()));
        return Val(v, '<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>' +
          parts.map((p) => p.html()).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>');
      }

      case 'dice': return rollDice(node, ctx);

      case 'paren': {
        const inner = evalNode(node.v, ctx);
        // grouping only — a bracket never turns a value into a set
        const value = inner.set
          ? SetVal(inner.members, { uid: node.uid, brackets: true })
          : Group(inner, node.uid);
        return applyMods(value, node.mods || [], null);
      }

      case 'set': {
        const parts = node.items.map((i) => evalNode(i, ctx));
        return applyMods(SetVal(flatten(parts), { uid: node.uid, brackets: true }), node.mods || [], null);
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
        return applyMods(SetVal(members, { uid: node.uid, brackets: true, prefix }), node.mods || [], null);
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
      case '=': return 'exactly ' + cp.v;
      case '!=': return 'anything but ' + cp.v;
      case '<': return 'less than ' + cp.v;
      case '>': return 'more than ' + cp.v;
      case '<=': return cp.v + ' or less';
      case '>=': return cp.v + ' or more';
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
      case 'check': {
        const c = CHECKS[m.check];
        return [c.label, 'Mark every member of ' + cpPhrase(m.cp) + ' as ' + c.hit + '. ' +
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
          push([node.count.sp[0], node.brk[0][1]], 't-rep', {
            title: 'Repeat into a set',
            desc: 'Evaluate the bracket ' + plain(node.count) +
              ' separate times and collect the results as a set.',
            depth
          }, rid);
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

  function previewNode(node) {
    switch (node.t) {
      case 'num': return '<span class="r-num">' + fmt(node.v) + '</span>';
      case 'str': return '<span class="r-str">' + esc(node.v) + '</span>';
      case 'word': return '<span class="r-var" data-x="w' + node.uid + '">' + esc(node.name) + '</span>';
      case 'ternary':
        return previewNode(node.cond) + '<span class="r-op" data-x="t' + node.uid + '">?</span>' +
          previewNode(node.yes) + '<span class="r-op" data-x="t' + node.uid + '">:</span>' +
          previewNode(node.no);
      case 'custom': {
        const shape = shapeFor(node.items.length);
        return '<span class="die ghost custom s-' + shape + '" data-x="c' + node.uid + '">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true"><use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval' + (String(node.items.length).length === 2 ? ' v2' : '') + '">' +
          node.items.length + '</span></span>';
      }
      case 'neg': return '<span class="r-op">-</span>' + previewNode(node.v);
      case 'bin':
        return previewNode(node.l) +
          '<span class="r-op"' + (node.uid ? ' data-x="o' + node.uid + '"' : '') + '>' +
          esc(node.op) + '</span>' + previewNode(node.r);
      case 'func':
        return '<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>' +
          node.args.map(previewNode).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>';
      case 'paren': case 'set': case 'rep': {
        const tag = ' data-x="s' + node.uid + '"';
        const items = (node.t === 'paren' ? [node.v] : node.items).map(previewNode)
          .join('<span class="r-op">,</span>');
        const pre = node.t === 'rep' ? '<span class="r-num">' + esc(plain(node.count)) + '</span>' : '';
        return '<span class="r-grp"' + tag + '>' + pre + '<span class="r-brk"' + tag + '>(</span>' +
          items + '<span class="r-brk"' + tag + '>)</span></span>';
      }
      case 'dice': {
        const sides = constOf(node.sides);
        const qty = node.qty === null ? 1 : constOf(node.qty);
        const shape = sides === null ? 'd20' : shapeFor(Math.floor(sides));
        const face = sides === null ? '?' : fmt(Math.floor(sides));
        const n = (qty === null || !(qty >= 0)) ? 1 : Math.floor(qty);
        const shown = Math.max(1, Math.min(n, PREVIEW_MAX));
        const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');
        const tag = ' data-x="d' + node.uid + '"';
        const one = '<span class="die ghost s-' + shape + '"' + tag + '>' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
          '<use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval' + size + '">' + esc(face) + '</span></span>';
        const squeezed = n > SQUEEZE_AT;
        const parts = new Array(shown).fill(one);
        return '<span class="r-term' + (squeezed ? ' squeezed' : '') + '"' + tag +
          squeezeStyle(shown) + '>' + (squeezed ? parts.join('') : parts.join(PLUS)) + '</span>';
      }
    }
    return '';
  }

  /* ==========================================================================
     PUBLIC API
     ========================================================================== */
  function splitParts(src) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { out.push({ text: src.slice(start, i), a: start }); start = i + 1; }
    }
    out.push({ text: src.slice(start), a: start });
    return out;
  }

  function parse(input) {
    const raw = String(input == null ? '' : input);
    let src = raw.trim();
    if (!src) throw new DiceError('nothing to roll', 0);

    let label = null, labelSp = null;
    const hash = src.indexOf('#');
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
    let uid = 0;
    for (const piece of splitParts(src)) {
      if (!piece.text.trim()) throw new DiceError('empty roll between commas', offset + piece.a);
      const p = new Parser(piece.text, uid);
      let ast;
      try {
        ast = p.parse();
        typeCheck(ast, false);
      } catch (e) {
        if (e instanceof DiceError && e.pos != null) e.pos += offset + piece.a;
        throw e;
      }
      uid = p.uid;
      parts.push({ ast, a: offset + piece.a, src: piece.text });
    }

    return {
      parts, ast: parts[0].ast, repeat, repeatSp, label, labelSp, offset, src,
      trimmed: raw.trim(), notation: parts.map((p) => plain(p.ast)).join(', ')
    };
  }

  function inspect(input) {
    const p = parse(input);
    const spans = [], rows = [];
    p.parts.forEach((part, i) => {
      const d = describe(part.ast, part.src);
      for (const s of d.spans) spans.push({ a: s.a + part.a, b: s.b + part.a, cls: s.cls, id: s.id });
      for (const r of d.rows) rows.push(Object.assign({}, r));
      if (i < p.parts.length - 1) {
        const c = p.parts[i + 1].a - 1;
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

  const evaluate = (ast) => evalNode(ast, { dice: 0, depth: 0 });

  function countDice(v) {
    if (!v) return 0;
    if (v.die) return 1;
    if (v.set) { let n = 0; for (const m of v.members) n += countDice(m); return n; }
    return 0;
  }

  function roll(input) {
    const p = parse(input);
    const sets = [];
    const multi = p.repeat > 1 || p.parts.length > 1;
    for (let i = 0; i < p.repeat; i++) {
      for (const part of p.parts) {
        const r = evaluate(part.ast);
        if (multi) r.name = p.parts.length > 1 ? plain(part.ast) : null;
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
    for (const s of sets) {
      let m = null;
      if (s.check) {
        const c = CHECKS[s.check.kind];
        const key = s.check.hit ? c.hit : c.miss;
        if (key) m = { [key]: 1 };
      } else if (s.marks) m = s.marks();
      if (m) for (const k in m) marks[k] = (marks[k] || 0) + m[k];
    }

    return {
      input: p.trimmed, notation: p.notation, label: p.label, repeat: p.repeat,
      sets, diceCount, total, numeric,
      marks: Object.keys(marks).length ? marks : null
    };
  }

  function preview(input) {
    const p = parse(input);
    return p.parts.map((part) => previewNode(part.ast)).join('<span class="r-op">,</span>');
  }

  function analyse(input, n) {
    const p = parse(input);
    n = n || 20000;
    const totals = new Array(n);
    let sum = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (let r = 0; r < p.repeat; r++) for (const part of p.parts) t += evaluate(part.ast).total();
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
    DiceError, LIMIT, FUNCS, CHECKS
  };
}(window));
