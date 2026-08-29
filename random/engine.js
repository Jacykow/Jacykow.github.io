/* ============================================================================
   Random Engine — dice notation parser, evaluator & explainer
   ----------------------------------------------------------------------------
   Grammar follows the rpg-dice-roller dialect (the most complete descendant of
   the Sidekick / Dice Maiden Discord notation), plus a few Dice Maiden aliases.

     expr    := term (('+' | '-') term)*
     term    := power (('*' | '/' | '%') power)*
     power   := unary (('^' | '**') power)?
     unary   := ('-' | '+')? primary
     primary := number | func '(' expr,* ')' | '(' expr ')' modifier* | dice
     dice    := [qty] ('d'|'D') sides modifier*
     sides   := integer | '(' expr ')'

   Modifiers after a bracket act on every die inside it: `(3d6+2d8)kh3`.

   Every node records its source span so the UI can syntax-highlight the input
   and cross-link it with a plain-English explanation, RegExr style.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- limits */
  const LIMIT = {
    qty: 5000,        // dice per term
    sides: 1000000,
    explode: 500,     // chained explosions per die
    reroll: 500,      // rerolls per die
    totalDice: 20000  // dice per whole evaluation
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

  /* ----------------------------------------------------------- math funcs */
  const FUNCS = {
    abs: Math.abs, ceil: Math.ceil, cos: Math.cos, exp: Math.exp,
    floor: Math.floor, log: Math.log, max: Math.max, min: Math.min,
    pow: Math.pow, sign: Math.sign, sin: Math.sin, sqrt: Math.sqrt, tan: Math.tan,
    round: (x) => Math.sign(x) * Math.round(Math.abs(x))   // half away from zero
  };

  const FUNC_DESC = {
    abs: 'absolute value', ceil: 'round up', cos: 'cosine', exp: 'e to the power of',
    floor: 'round down', log: 'natural logarithm', max: 'the largest argument',
    min: 'the smallest argument', pow: 'raise to a power', round: 'round to nearest',
    sign: 'sign (-1, 0 or 1)', sin: 'sine', sqrt: 'square root', tan: 'tangent'
  };

  /* Application order of dice modifiers — lower runs first. */
  const ORDER = {
    min: 1, max: 2, explode: 3, reroll: 4, unique: 5, keep: 6, drop: 7,
    target: 8, failure: 8.5, critSuccess: 9, critFail: 10
  };

  class DiceError extends Error {
    constructor(msg, pos) { super(msg); this.name = 'DiceError'; this.pos = pos; }
  }

  /* ==========================================================================
     PARSER
     ========================================================================== */
  class Parser {
    // uid tags dice and bracket-group nodes so the editor, the Explain list and
    // the rolled dice can all point at the same thing when hovered
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

    /** literal match that must not be followed by another letter */
    word(str) {
      const save = this.i;
      if (!this.lit(str)) return false;
      if (/[a-z]/i.test(this.s[this.i] || '')) { this.i = save; return false; }
      return true;
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

    /* ------------------------------------------------------------ entry */
    parse() {
      const node = this.expr();
      if (!this.end()) this.fail('unexpected "' + this.s[this.i] + '"');
      return node;
    }

    expr() {
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

    /** true when the cursor sits on a `d` that begins a dice spec */
    atDice() {
      this.ws();
      const c = this.s[this.i];
      if (c !== 'd' && c !== 'D') return false;
      const rest = this.s.slice(this.i + 1).replace(/^\s*/, '');
      return /^\d/.test(rest) || rest[0] === '(';
    }

    primary() {
      const a = this.mark();
      if (this.end()) this.fail('unexpected end of expression');

      if (this.atDice()) return this.dice(null, a);

      const fn = /^([a-z]+)\s*\(/i.exec(this.s.slice(this.i));
      if (fn) {
        const name = fn[1].toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(FUNCS, name)) {
          this.fail('unknown function "' + name + '"');
        }
        const nameSp = [a, a + fn[1].length];
        this.i += fn[0].length;
        const openSp = [this.i - 1, this.i];
        const args = [this.expr()];
        while (this.lit(',')) args.push(this.expr());
        const cA = this.mark();
        if (!this.lit(')')) this.fail('expected ")" to close ' + name + '()');
        const node = { t: 'func', name, args, nameSp, brk: [openSp, [cA, this.i]], sp: [a, this.i] };
        return this.maybeDice(node, a);
      }

      const pA = this.mark();
      if (this.lit('(')) {
        const openSp = [pA, this.i];
        const inner = this.expr();
        const cA = this.mark();
        if (!this.lit(')')) this.fail('expected ")"');
        const brk = [openSp, [cA, this.i]];
        const closeEnd = this.i;
        // `(2+2)d6` — the parentheses are a dice quantity
        if (this.atDice()) return this.dice({ t: 'paren', v: inner, brk, sp: [a, closeEnd] }, a);
        // `(3d6+2d8)kh3` — modifiers after the bracket act on every die inside
        const mods = this.modifiers();
        if (mods.length) {
          return {
            t: 'group', sub: inner, mods, brk,
            core: [a, closeEnd], sp: [a, this.i], uid: ++this.uid
          };
        }
        return { t: 'paren', v: inner, brk, sp: [a, this.i], uid: ++this.uid };
      }

      const nA = this.mark();
      const n = this.number();
      if (n !== null) return this.maybeDice({ t: 'num', v: n, sp: [nA, this.i] }, a);

      this.fail('unexpected "' + this.s[this.i] + '"');
    }

    maybeDice(qty, a) {
      return this.atDice() ? this.dice(qty, a) : qty;
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

    /** a bare number after a modifier is shorthand for "equal to n" */
    bareCp() {
      const n = this.digits();          // unsigned only: `1d6!-1` must stay a subtraction
      return n === null ? null : { op: '=', v: n };
    }

    cpAny() { return this.comparePoint() || this.bareCp(); }

    /** an explicit comparison, or a bare number read in the modifier's
        natural direction: e6 explodes on 6+, r2 re-rolls 2 and below */
    cpDir(dir) {
      const cp = this.comparePoint();
      if (cp) return cp;
      const n = this.digits();
      return n === null ? null : { op: dir, v: n };
    }

    /* ---------------------------------------------------------- modifiers */
    modifiers() {
      const mods = [];
      for (;;) {
        const m = this.modifier();
        if (!m) return mods;
        // `!!` used to mean compounding. It is gone, and left unguarded it now
        // parses as two explode passes and quietly doubles the dice.
        if (m.t === 'explode' && mods.some((p) => p.t === 'explode')) {
          this.fail('a die can only explode once — "!!" is no longer a modifier');
        }
        mods.push(m);
      }
    }

    fin(start, m) { m.sp = [start, this.i]; return m; }

    modifier() {
      const start = this.mark();
      const back = () => { this.i = start; return null; };

      // -- min / max clamps -------------------------------------------------
      if (this.lit('min')) {
        const n = this.signedInt();
        return n === null ? back() : this.fin(start, { t: 'min', n });
      }
      if (this.lit('max')) {
        const n = this.signedInt();
        return n === null ? back() : this.fin(start, { t: 'max', n });
      }

      /* Anything that can repeat follows one rule: the plain letter does it
         once, a trailing `i` does it for as long as it keeps qualifying.
         `u` is exempt — it narrows the set of allowed values rather than
         repeating a roll. */

      // -- exploding: e, ei, and the penetrating pair ep, epi ---------------
      if (this.lit('epi')) return this.fin(start, { t: 'explode', pen: true, inf: true, cp: this.cpDir('>=') });
      if (this.lit('ep')) return this.fin(start, { t: 'explode', pen: true, inf: false, cp: this.cpDir('>=') });
      if (this.lit('ei')) return this.fin(start, { t: 'explode', pen: false, inf: true, cp: this.cpDir('>=') });
      if (this.lit('e')) return this.fin(start, { t: 'explode', pen: false, inf: false, cp: this.cpDir('>=') });

      // -- reroll -----------------------------------------------------------
      if (this.lit('ri')) return this.fin(start, { t: 'reroll', inf: true, cp: this.cpDir('<=') });
      if (this.lit('r')) return this.fin(start, { t: 'reroll', inf: false, cp: this.cpDir('<=') });

      // -- unique -----------------------------------------------------------
      if (this.lit('uo')) return this.fin(start, { t: 'unique', once: true, cp: this.cpDir('=') });
      if (this.lit('u')) return this.fin(start, { t: 'unique', once: false, cp: this.cpDir('=') });

      // -- keep / drop ------------------------------------------------------
      if (this.lit('kh')) return this.fin(start, { t: 'keep', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('kl')) return this.fin(start, { t: 'keep', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('dh')) return this.fin(start, { t: 'drop', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('dl')) return this.fin(start, { t: 'drop', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('d')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'drop', end: 'l', n });
      }

      // -- criticals --------------------------------------------------------
      if (this.lit('cs')) return this.fin(start, { t: 'critSuccess', cp: this.cpDir('>=') });
      if (this.lit('cf')) return this.fin(start, { t: 'critFail', cp: this.cpDir('<=') });

      // -- failures ---------------------------------------------------------
      if (this.lit('f')) {
        const cp = this.cpDir('<=');
        return cp ? this.fin(start, { t: 'failure', cp }) : back();
      }

      // -- bare comparison = target success ---------------------------------
      const cp = this.comparePoint();
      if (cp) return this.fin(start, { t: 'target', cp });

      return back();
    }
  }

  /* ==========================================================================
     EVALUATOR
     Result nodes expose total() and html(), so modifiers applied late (group
     keep/drop) can mark dice as dropped and every total simply recomputes.
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

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function fmt(n) {
    if (!isFinite(n)) return String(n);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  }

  const cpText = (cp) => cp ? cp.op + cp.v : '';

  /* Which solid to draw for a given number of sides.
     d4/d6/d8/d12/d20 are the Platonic solids, d10 a pentagonal trapezohedron,
     d100 a zocchihedron, d2 a coin. Even sizes without a Platonic solid are
     n/2-gon bipyramids; odd ones are long n-gon barrels that cannot land on an
     end. d3 borrows the cube, anything else at or under 20 borrows the d20,
     and anything larger borrows the d100. Fudge dice have no die to draw. */
  const SOLIDS = {
    2: 'd2', 3: 'd6', 4: 'd4', 5: 'd5', 6: 'd6', 7: 'd7', 8: 'd8', 9: 'd9',
    10: 'd10', 11: 'd11', 12: 'd12', 14: 'd14', 16: 'd16', 18: 'd18',
    20: 'd20', 100: 'd100'
  };
  function shapeFor(sides) {
    if (SOLIDS[sides]) return SOLIDS[sides];
    return sides > 20 ? 'd100' : 'd20';
  }

  function dieHTML(r, shape, tag) {
    const cls = ['die', 's-' + shape].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const title = (r.tags.length ? r.tags.join(', ') : 'natural') +
      (r.dropped ? ', dropped' : '') +
      (r.from !== null && r.from !== undefined ? ', was ' + fmt(r.from) : '');

    const face = fmt(r.v);
    const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');

    // one corner slot: a re-rolled die shows what it was, otherwise mark explosions
    let badge = '';
    if (r.from !== null && r.from !== undefined) badge = '<s>' + esc(fmt(r.from)) + '</s>';
    else if (r.tags.indexOf('exploded') >= 0) badge = '!';

    return '<span class="' + cls.join(' ') + '"' + tag + ' title="' + esc(title) + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + esc(face) + '</span>' +
      (badge ? '<span class="diebadge">' + badge + '</span>' : '') +
      '</span>';
  }

  /** compact chip used when a roll has too many dice to draw as shapes */
  function chipHTML(r, tag) {
    const cls = ['chip-die'].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const was = (r.from !== null && r.from !== undefined) ? '<s>' + esc(fmt(r.from)) + '</s>' : '';
    const bang = r.tags.indexOf('exploded') >= 0 ? '<sup>!</sup>' : '';
    return '<span class="' + cls.join(' ') + '"' + tag + '>' + was + esc(fmt(r.v)) + bang + '</span>';
  }

  const PLUS = '<span class="r-plus">+</span>';

  /* Subtotals are not written inline any more: each summing node just carries
     its value, and the UI draws them as a tree underneath the dice. A term of
     more than SQUEEZE_AT dice overlaps them so it never takes more room than
     that many — the individual faces stop mattering at that point. */
  const SQUEEZE_AT = 3;
  function squeezeStyle(n) {
    if (n <= SQUEEZE_AT) return '';
    // n dice with margin m must span SQUEEZE_AT dice: m = (SQUEEZE_AT - n)/(n - 1)
    return ' style="--sq:' + ((SQUEEZE_AT - n) / (n - 1)).toFixed(4) + '"';
  }

  /* -------------------------------------------------------- result nodes */
  const NumResult = (v) => ({
    k: 'num', total: () => v, html: () => '<span class="r-num">' + fmt(v) + '</span>'
  });

  function BinResult(op, l, r, uid) {
    const tag = uid ? ' data-x="o' + uid + '"' : '';
    return {
      k: 'bin', children: [l, r],
      total() {
        const a = l.total(), b = r.total();
        switch (op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return a / b;
          case '%': return a % b;
          case '^': return Math.pow(a, b);
        }
      },
      html: (o) => l.html(o) + '<span class="r-op"' + tag + '>' + esc(op) + '</span>' + r.html(o)
    };
  }

  const NegResult = (v) => ({
    k: 'neg', children: [v], total: () => -v.total(),
    html: (o) => '<span class="r-op">-</span>' + v.html(o)
  });

  const ParenResult = (v, uid) => ({
    k: 'paren', inner: v, children: [v], total: () => v.total(),
    html(o) {
      const tag = uid ? ' data-x="p' + uid + '"' : '';
      return '<span class="r-grp"' + tag + ' data-sum="' + esc(fmt(this.total())) + '">' +
        '<span class="r-brk"' + tag + '>(</span>' + v.html(o) +
        '<span class="r-brk"' + tag + '>)</span></span>';
    }
  });

  const FuncResult = (name, args) => ({
    k: 'func', children: args,
    total: () => FUNCS[name].apply(null, args.map((a) => a.total())),
    html: (o) => '<span class="r-fn">' + name + '</span><span class="r-brk">(</span>' +
      args.map((a) => a.html(o)).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>'
  });

  /* --------------------------------------------------------- dice rolling */
  const makeDie = (sides) => rng.int(1, sides);

  function rollDice(node, ctx) {
    const sides = Math.floor(node.sides.t === 'num' ? node.sides.v : evalNode(node.sides, ctx).total());
    if (!(sides >= 1)) throw new DiceError('a die needs at least 1 side (got ' + sides + ')');
    if (sides > LIMIT.sides) throw new DiceError('too many sides (max ' + LIMIT.sides + ')');
    const qty = node.qty === null ? 1
      : Math.floor(node.qty.t === 'num' ? node.qty.v : evalNode(node.qty, ctx).total());
    if (!(qty >= 0)) throw new DiceError('dice quantity must be 0 or more (got ' + qty + ')');
    if (qty > LIMIT.qty) throw new DiceError('too many dice (max ' + LIMIT.qty + ')');
    ctx.dice += qty;
    if (ctx.dice > LIMIT.totalDice) throw new DiceError('too many dice in one expression');

    const dmin = 1, dmax = sides;

    let rolls = [];
    for (let i = 0; i < qty; i++) rolls.push({ v: makeDie(sides), tags: [], from: null });

    const tag = (r, t) => { if (r.tags.indexOf(t) < 0) r.tags.push(t); };
    const mods = node.mods.slice().sort((a, b) => (ORDER[a.t] || 99) - (ORDER[b.t] || 99));
    let successCp = null, failureCp = null;

    for (const m of mods) {
      switch (m.t) {
        case 'min':
          for (const r of rolls) if (r.v < m.n) { if (r.from === null) r.from = r.v; r.v = m.n; tag(r, 'clamped'); }
          break;

        case 'max':
          for (const r of rolls) if (r.v > m.n) { if (r.from === null) r.from = r.v; r.v = m.n; tag(r, 'clamped'); }
          break;

        case 'explode': {
          const cp = m.cp || { op: '=', v: dmax };
          const out = [];
          for (const r of rolls) {
            out.push(r);
            let last = r.v, n = 0;
            while (cpTest(cp, last) && n < LIMIT.explode) {
              n++;
              if (++ctx.dice > LIMIT.totalDice) throw new DiceError('explosion ran away — too many dice');
              const raw = makeDie(sides);
              last = raw;
              const val = m.pen ? raw - 1 : raw;
              out.push({ v: val, tags: ['exploded'], from: null });
              if (!m.inf) break;
            }
            if (n > 0) tag(r, 'exploded');
          }
          rolls = out;
          break;
        }

        case 'reroll': {
          const cp = m.cp || { op: '=', v: dmin };
          for (const r of rolls) {
            let n = 0;
            while (cpTest(cp, r.v) && n < LIMIT.reroll) {
              if (r.from === null) r.from = r.v;
              r.v = makeDie(sides);
              tag(r, 'rerolled');
              n++;
              if (!m.inf) break;
            }
          }
          break;
        }

        case 'unique': {
          const seen = new Set();
          for (const r of rolls) {
            let n = 0;
            while (seen.has(r.v) && (!m.cp || cpTest(m.cp, r.v)) && n < LIMIT.reroll) {
              if (r.from === null) r.from = r.v;
              r.v = makeDie(sides);
              tag(r, 'rerolled');
              n++;
              if (m.once) break;
            }
            seen.add(r.v);
          }
          break;
        }

        case 'keep': {
          const live = rolls.filter((r) => !r.dropped);
          const order = live.slice().sort((a, b) => b.v - a.v);
          const keep = new Set(m.end === 'l' ? order.slice(-m.n) : order.slice(0, m.n));
          for (const r of live) if (!keep.has(r)) r.dropped = true;
          break;
        }

        case 'drop': {
          const live = rolls.filter((r) => !r.dropped);
          const order = live.slice().sort((a, b) => b.v - a.v);
          for (const r of (m.end === 'h' ? order.slice(0, m.n) : order.slice(-m.n))) r.dropped = true;
          break;
        }

        case 'target': successCp = m.cp; break;
        case 'failure': failureCp = m.cp; break;

        case 'critSuccess': {
          const cp = m.cp || { op: '=', v: dmax };
          for (const r of rolls) if (cpTest(cp, r.v)) tag(r, 'critSuccess');
          break;
        }

        case 'critFail': {
          const cp = m.cp || { op: '=', v: dmin };
          for (const r of rolls) if (cpTest(cp, r.v)) tag(r, 'critFail');
          break;
        }

      }
    }

    if (successCp || failureCp) {
      for (const r of rolls) {
        if (r.dropped) continue;
        if (successCp && cpTest(successCp, r.v)) tag(r, 'success');
        else if (failureCp && cpTest(failureCp, r.v)) tag(r, 'failure');
      }
    }

    return {
      k: 'dice', rolls, sides, qty, uid: node.uid,
      notation: notationOf(node),
      successMode: !!(successCp || failureCp),

      successes() { return rolls.filter((r) => !r.dropped && r.tags.indexOf('success') >= 0).length; },
      failures() { return rolls.filter((r) => !r.dropped && r.tags.indexOf('failure') >= 0).length; },

      total() {
        if (this.successMode) return this.successes() - this.failures();
        let s = 0;
        for (const r of rolls) if (!r.dropped) s += r.v;
        return s;
      },

      html(o) {
        const shape = shapeFor(this.sides);
        const tag = this.uid ? ' data-x="d' + this.uid + '"' : '';
        const parts = rolls.map((r) => (o && o.plain) ? chipHTML(r, tag) : dieHTML(r, shape, tag));
        const many = rolls.length > SQUEEZE_AT;
        const squeezed = rolls.length > SQUEEZE_AT;
        // the + between dice in a term is what the notation actually means
        const body = squeezed ? parts.join('') : parts.join(PLUS);
        return '<span class="r-term' + (squeezed ? ' squeezed' : '') + '"' + tag +
          (many ? ' data-sum="' + esc(fmt(this.total())) + '"' : '') +
          squeezeStyle(rolls.length) + '>' + body + '</span>';
      }
    };
  }

  /* -------------------------------------------------------- group results */
  /* Bracket group: modifiers written after ')' act on every die inside it. */
  function evalGroup(node, ctx) {
    const sub = evalNode(node.sub, ctx);
    const mods = node.mods.slice().sort((x, y) => (ORDER[x.t] || 99) - (ORDER[y.t] || 99));
    const dice = [];
    collectDice(sub, dice);

    let successCp = null, failureCp = null;
    for (const m of mods) {
      switch (m.t) {
        case 'keep': {
          const live = dice.filter((r) => !r.dropped);
          const order = live.slice().sort((x, y) => y.v - x.v);
          const keep = new Set(m.end === 'l' ? order.slice(-m.n) : order.slice(0, m.n));
          for (const r of live) if (!keep.has(r)) r.dropped = true;
          break;
        }
        case 'drop': {
          const live = dice.filter((r) => !r.dropped);
          const order = live.slice().sort((x, y) => y.v - x.v);
          for (const r of (m.end === 'h' ? order.slice(0, m.n) : order.slice(-m.n))) r.dropped = true;
          break;
        }
        case 'target': successCp = m.cp; break;
        case 'failure': failureCp = m.cp; break;
      }
    }
    if (successCp || failureCp) {
      for (const r of dice) {
        if (r.dropped) continue;
        if (successCp && cpTest(successCp, r.v)) r.tags.push('success');
        else if (failureCp && cpTest(failureCp, r.v)) r.tags.push('failure');
      }
    }

    return {
      k: 'group', sub, children: [sub], uid: node.uid,
      successMode: !!(successCp || failureCp),
      successes() { return dice.filter((r) => !r.dropped && r.tags.indexOf('success') >= 0).length; },
      failures() { return dice.filter((r) => !r.dropped && r.tags.indexOf('failure') >= 0).length; },
      total() {
        return this.successMode ? this.successes() - this.failures() : sub.total();
      },
      html(o) {
        const tag = this.uid ? ' data-x="g' + this.uid + '"' : '';
        return '<span class="r-grp"' + tag + ' data-sum="' + esc(fmt(this.total())) + '">' +
          '<span class="r-brk"' + tag + '>(</span>' + sub.html(o) +
          '<span class="r-brk"' + tag + '>)</span></span>';
      }
    };
  }

  function collectDice(node, out) {
    if (!node) return;
    if (node.k === 'dice') { for (const r of node.rolls) out.push(r); return; }
    if (node.children) for (const c of node.children) collectDice(c, out);
  }

  /* ---------------------------------------------------------- dispatcher */
  function evalNode(node, ctx) {
    switch (node.t) {
      case 'num': return NumResult(node.v);
      case 'neg': return NegResult(evalNode(node.v, ctx));
      case 'paren': return ParenResult(evalNode(node.v, ctx), node.uid);
      case 'bin': return BinResult(node.op, evalNode(node.l, ctx), evalNode(node.r, ctx), node.uid);
      case 'func': return FuncResult(node.name, node.args.map((a) => evalNode(a, ctx)));
      case 'dice': return rollDice(node, ctx);
      case 'group': return evalGroup(node, ctx);
    }
    throw new DiceError('cannot evaluate node "' + node.t + '"');
  }

  /* ------------------------------------------- notation reconstruction */
  function notationOf(node) {
    const q = node.qty === null ? '' : plain(node.qty);
    let sides;
    if (node.sides.t === 'num') sides = plain(node.sides);
    else sides = '(' + plain(node.sides) + ')';     // computed sides keep their parentheses
    return q + 'd' + sides + node.mods.map(modText).join('');
  }

  function modText(m) {
    switch (m.t) {
      case 'min': return 'min' + m.n;
      case 'max': return 'max' + m.n;
      case 'explode': return 'e' + (m.pen ? 'p' : '') + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'reroll': return 'r' + (m.inf ? 'i' : '') + cpText(m.cp);
      case 'unique': return (m.once ? 'uo' : 'u') + cpText(m.cp);
      case 'keep': return 'k' + m.end + m.n;
      case 'drop': return 'd' + m.end + m.n;
      case 'target': return cpText(m.cp);
      case 'failure': return 'f' + cpText(m.cp);
      case 'critSuccess': return 'cs' + cpText(m.cp);
      case 'critFail': return 'cf' + cpText(m.cp);
    }
    return '';
  }

  function plain(node) {
    switch (node.t) {
      case 'num': return fmt(node.v);
      case 'neg': return '-' + plain(node.v);
      case 'paren': return '(' + plain(node.v) + ')';
      case 'bin': return plain(node.l) + node.op + plain(node.r);
      case 'func': return node.name + '(' + node.args.map(plain).join(', ') + ')';
      case 'dice': return notationOf(node);
      case 'group': return '(' + plain(node.sub) + ')' + node.mods.map(modText).join('');
    }
    return '?';
  }

  /* ==========================================================================
     SPANS + EXPLAIN  (drives the highlighted editor and the Explain panel)
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

  const ord = (n) => n === 1 ? '' : n + ' ';

  function modExplain(m, dieWord) {
    const d = dieWord || 'die';
    switch (m.t) {
      case 'min': return ['Minimum', 'Any roll below ' + m.n + ' counts as ' + m.n + '.'];
      case 'max': return ['Maximum', 'Any roll above ' + m.n + ' counts as ' + m.n + '.'];
      case 'explode': {
        const on = m.cp ? cpPhrase(m.cp) : 'its highest face';
        let how = 'roll an extra ' + d + ' and add it alongside';
        if (m.pen) how += ', subtracting 1 from every extra roll';
        const times = m.inf ? ' Repeats as long as it keeps happening.' : ' One extra roll per die.';
        return [m.pen ? 'Penetrating explode' : 'Exploding',
                'When a ' + d + ' rolls ' + on + ', ' + how + '.' + times];
      }
      case 'reroll': return ['Re-roll',
        'Any ' + d + ' showing ' + cpPhrase(m.cp, 'its lowest face') + ' is re-rolled' +
        (m.inf ? ' until it no longer qualifies.' : ' once — the new value stands.')];
      case 'unique': return ['Unique',
        'Duplicate results are re-rolled' + (m.once ? ' once' : '') + ' so every ' + d + ' shows a different value' +
        (m.cp ? ', but only for dice showing ' + cpPhrase(m.cp) + '.' : '.')];
      case 'keep': return ['Keep ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Keep only the ' + ord(m.n) + (m.end === 'h' ? 'highest' : 'lowest') + (m.n === 1 ? ' result' : ' results') + '; the rest are struck out.'];
      case 'drop': return ['Drop ' + (m.end === 'h' ? 'highest' : 'lowest'),
        'Throw away the ' + ord(m.n) + (m.end === 'h' ? 'highest' : 'lowest') + (m.n === 1 ? ' result' : ' results') + '.'];
      case 'target': return ['Count successes',
        'Stop summing. Instead count every ' + d + ' showing ' + cpPhrase(m.cp) + ' as one success.'];
      case 'failure': return ['Count failures',
        'Every ' + d + ' showing ' + cpPhrase(m.cp) + ' subtracts one from the success count.'];
      case 'critSuccess': return ['Critical success',
        'Flag any ' + d + ' showing ' + cpPhrase(m.cp, 'its highest face') + ' as a critical success (display only).'];
      case 'critFail': return ['Critical failure',
        'Flag any ' + d + ' showing ' + cpPhrase(m.cp, 'its lowest face') + ' as a critical failure (display only).'];
    }
    return ['Modifier', ''];
  }

  const OP_NAMES = {
    '+': ['Add', 'Add the value on the right to the running total.'],
    '-': ['Subtract', 'Subtract the value on the right from the running total.'],
    '*': ['Multiply', 'Multiply the two sides together.'],
    '/': ['Divide', 'Divide the left side by the right. Fractions are kept — wrap it in floor() to round down.'],
    '%': ['Remainder', 'The remainder after dividing the left side by the right.'],
    '^': ['Power', 'Raise the left side to the power of the right.']
  };

  /**
   * Walk the AST and produce:
   *   spans — [{a, b, cls, id}] for syntax highlighting
   *   rows  — [{id, code, title, desc, depth}] for the Explain panel
   */
  function describe(ast, src) {
    const spans = [];
    const rows = [];
    let uid = 0;

    const push = (sp, cls, row, fixedId) => {
      if (!sp) return null;
      const id = row ? (fixedId || 'x' + (++uid)) : null;
      spans.push({ a: sp[0], b: sp[1], cls, id });
      if (row) rows.push(Object.assign({ id, code: src.slice(sp[0], sp[1]) }, row));
      return id;
    };

    function diceDesc(node) {
      const s = node.sides;
      const q = node.qty === null ? '1' : plain(node.qty);
      const many = q !== '1';
      const dieWord = many ? 'dice' : 'die';
      const sides = plain(s);
      const computed = s.t !== 'num';
      return 'Roll ' + q + ' ' + (computed ? '(' + sides + ')' : sides) + '-sided ' +
        dieWord + (many ? ' and sum them' : '') + '.' +
        (computed || node.qty && node.qty.t !== 'num' ? ' Quantity and sides are worked out first.' : '');
    }

    function walk(node, depth) {
      switch (node.t) {
        case 'num':
          push(node.sp, 't-num', { title: 'Constant', desc: 'The flat value ' + fmt(node.v) + '.', depth });
          break;

        case 'neg':
          push(node.opSp, 't-op', { title: 'Negate', desc: 'Flip the sign of what follows.', depth });
          walk(node.v, depth + 1);
          break;

        case 'paren': {
          const pid = node.uid ? 'p' + node.uid : null;
          push(node.brk[0], 't-brk', { title: 'Group', desc: 'Everything inside the parentheses is worked out first.', depth }, pid);
          walk(node.v, depth + 1);
          push(node.brk[1], 't-brk', null, pid);
          if (pid) spans[spans.length - 1].id = pid;
          break;
        }

        case 'bin': {
          walk(node.l, depth);
          const [title, desc] = OP_NAMES[node.op] || ['Operator', ''];
          push(node.opSp, 't-op', { title, desc, depth }, node.uid ? 'o' + node.uid : null);
          walk(node.r, depth);
          break;
        }

        case 'func':
          push(node.nameSp, 't-fn', {
            title: node.name + '()',
            desc: 'Apply ' + (FUNC_DESC[node.name] || node.name) + ' to the value inside.', depth
          });
          push(node.brk[0], 't-brk');
          node.args.forEach((a) => walk(a, depth + 1));
          push(node.brk[1], 't-brk');
          break;

        case 'dice': {
          const many = node.qty !== null && !(node.qty.t === 'num' && node.qty.v === 1);
          push(node.core, 't-dice', { title: 'Dice roll', desc: diceDesc(node), depth }, 'd' + node.uid);
          if (node.qty && node.qty.t !== 'num') walk(node.qty, depth + 1);
          if (node.sides.t !== 'num') walk(node.sides, depth + 1);
          for (const m of node.mods) {
            const [title, desc] = modExplain(m, many ? 'die' : 'die');
            push(m.sp, 't-mod', { title, desc, depth: depth + 1 });
          }
          break;
        }

        case 'group': {
          push(node.brk[0], 't-brk', {
            title: 'Bracket group',
            desc: 'Worked out first, and the modifiers after the bracket act on every die inside it rather than on one term.',
            depth
          }, 'g' + node.uid);
          walk(node.sub, depth + 1);
          push(node.brk[1], 't-brk');
          if (node.uid) spans[spans.length - 1].id = 'g' + node.uid;
          for (const m of node.mods) {
            const [title, desc] = modExplain(m, 'die');
            push(m.sp, 't-mod', { title, desc, depth: depth + 1 });
          }
          break;
        }
      }
    }

    walk(ast, 0);
    spans.sort((x, y) => x.a - y.a || x.b - y.b);
    return { spans, rows };
  }

  /* ==========================================================================
     PUBLIC API
     ========================================================================== */

  /** commas at bracket depth 0 separate whole rolls; inside a function they
      are argument separators, so only the top level counts */
  function splitParts(src) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { out.push({ text: src.slice(start, i), a: start }); start = i + 1; }
    }
    out.push({ text: src.slice(start), a: start });
    return out;
  }

  /** Split off a `3x` repeat prefix, a `# label` suffix and any top-level
      commas, then parse each part. */
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
      if (!piece.text.trim()) {
        throw new DiceError('empty roll between commas', offset + piece.a);
      }
      const p = new Parser(piece.text, uid);
      let ast;
      try {
        ast = p.parse();
      } catch (e) {
        if (e instanceof DiceError && e.pos != null) e.pos += offset + piece.a;
        throw e;
      }
      uid = p.uid;
      parts.push({ ast, a: offset + piece.a, src: piece.text });
    }

    return {
      parts, ast: parts[0].ast, repeat, repeatSp, label, labelSp, offset, src,
      trimmed: raw.trim(),
      notation: parts.map((p) => plain(p.ast)).join(', ')
    };
  }

  /** Everything the UI needs to highlight + explain an input string. */
  function inspect(input) {
    const p = parse(input);
    const spans = [], rows = [];
    p.parts.forEach((part, i) => {
      const d = describe(part.ast, part.src);
      for (const s of d.spans) spans.push({ a: s.a + part.a, b: s.b + part.a, cls: s.cls, id: s.id });
      for (const r of d.rows) rows.push(Object.assign({}, r));
      if (i < p.parts.length - 1) {
        const c = p.parts[i + 1].a - 1;                 // the comma between parts
        spans.push({ a: c, b: c + 1, cls: 't-op', id: 'xc' + i });
        rows.push({
          id: 'xc' + i, code: ',', depth: 0, title: 'Next roll',
          desc: 'A comma starts a separate roll. They are reported together as one entry.'
        });
      }
    });
    spans.sort((x, y) => x.a - y.a || x.b - y.b);

    if (p.repeatSp) {
      spans.unshift({ a: p.repeatSp[0], b: p.repeatSp[1], cls: 't-rep', id: 'xrep' });
      rows.unshift({
        id: 'xrep', code: p.trimmed.slice(p.repeatSp[0], p.repeatSp[1]), depth: 0,
        title: 'Repeat', desc: 'Roll the whole expression ' + p.repeat + ' separate times and report each set.'
      });
    }
    if (p.labelSp) {
      spans.push({ a: p.labelSp[0], b: p.labelSp[1], cls: 't-cmt', id: 'xlbl' });
      rows.push({
        id: 'xlbl', code: p.trimmed.slice(p.labelSp[0], p.labelSp[1]), depth: 0,
        title: 'Label', desc: 'Everything after # is a note attached to the roll — it never affects the maths.'
      });
    }
    return { parsed: p, spans, rows, notation: p.notation };
  }

  /** Evaluate a parsed AST once. */
  const evaluate = (ast) => evalNode(ast, { dice: 0 });

  /** Parse + evaluate, honouring the repeat prefix. */
  function roll(input) {
    const p = parse(input);
    const sets = [];
    const multi = p.repeat > 1 || p.parts.length > 1;
    for (let i = 0; i < p.repeat; i++) {
      for (const part of p.parts) {
        const r = evaluate(part.ast);
        // name each set when there is more than one, so the card can label them
        if (multi) r.name = p.parts.length > 1 ? plain(part.ast) : null;
        sets.push(r);
      }
    }
    let diceCount = 0;
    for (const s of sets) { const bag = []; collectDice(s, bag); diceCount += bag.length; }
    return {
      input: p.trimmed, notation: p.notation, label: p.label, repeat: p.repeat, sets, diceCount,
      total: sets.reduce((a, s) => a + s.total(), 0),
      successMode: sets.length > 0 && !!sets[0].successMode,
      successes: sets.reduce((a, s) => a + (s.successMode ? s.successes() : 0), 0),
      failures: sets.reduce((a, s) => a + (s.successMode ? s.failures() : 0), 0)
    };
  }

  /** Monte-Carlo the distribution of an expression's total. */
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
      p10: sorted[Math.floor(n * 0.10)],
      p90: sorted[Math.floor(n * 0.90)],
      totals, notation: p.notation
    };
  }

  /* ==========================================================================
     PREVIEW — what the expression *would* roll, drawn from the parse alone.
     The dice carry their die name rather than a face, since nothing has been
     rolled yet, and no subtotals appear because there is nothing to sum.
     ========================================================================== */
  const PREVIEW_MAX = 8;   // squeezed dice stack anyway; drawing more is waste

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
      case 'neg': return '<span class="r-op">-</span>' + previewNode(node.v);
      case 'paren': {
        const tag = node.uid ? ' data-x="p' + node.uid + '"' : '';
        return '<span class="r-grp"' + tag + '><span class="r-brk"' + tag + '>(</span>' +
          previewNode(node.v) + '<span class="r-brk"' + tag + '>)</span></span>';
      }
      case 'group':
        return '<span class="r-grp"' + (node.uid ? ' data-x="g' + node.uid + '"' : '') + '>' +
          '<span class="r-brk">(</span>' + previewNode(node.sub) + '<span class="r-brk">)</span></span>';
      case 'bin':
        return previewNode(node.l) +
          '<span class="r-op"' + (node.uid ? ' data-x="o' + node.uid + '"' : '') + '>' +
          esc(node.op) + '</span>' + previewNode(node.r);
      case 'func':
        return '<span class="r-fn">' + node.name + '</span><span class="r-brk">(</span>' +
          node.args.map(previewNode).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>';
      case 'dice': {
        const sides = constOf(node.sides);
        const qty = node.qty === null ? 1 : constOf(node.qty);
        const shape = sides === null ? 'd20' : shapeFor(Math.floor(sides));
        const face = sides === null ? '?' : fmt(Math.floor(sides));
        const n = (qty === null || !(qty >= 0)) ? 1 : Math.floor(qty);
        const shown = Math.max(1, Math.min(n, PREVIEW_MAX));
        const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');
        const tag = node.uid ? ' data-x="d' + node.uid + '"' : '';
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

  /** HTML for the dice an expression would roll. Never throws on a valid parse. */
  function preview(input) {
    const p = parse(input);
    return p.parts.map((part) => previewNode(part.ast))
      .join('<span class="r-op">,</span>');
  }

  global.DiceEngine = {
    parse, inspect, evaluate, roll, analyse, preview, fmt, esc, shapeFor,
    DiceError, LIMIT, FUNCS
  };
}(window));
