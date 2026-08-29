/* ============================================================================
   Random Engine — dice notation parser, evaluator & explainer
   ----------------------------------------------------------------------------
   Grammar follows the rpg-dice-roller dialect (the most complete descendant of
   the Sidekick / Dice Maiden Discord notation), plus a few Dice Maiden aliases.

     expr    := term (('+' | '-') term)*
     term    := power (('*' | '/' | '%') power)*
     power   := unary (('^' | '**') power)?
     unary   := ('-' | '+')? primary
     primary := number | group | func '(' expr,* ')' | '(' expr ')' | dice
     dice    := [qty] ('d'|'D') sides modifier*
     sides   := integer | '%' | 'F' ['.' digit] | '(' expr ')'
     group   := '{' expr (',' expr)* '}' modifier*

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
    target: 8, failure: 8.5, critSuccess: 9, critFail: 10, sort: 11
  };

  class DiceError extends Error {
    constructor(msg, pos) { super(msg); this.name = 'DiceError'; this.pos = pos; }
  }

  /* ==========================================================================
     PARSER
     ========================================================================== */
  class Parser {
    constructor(src) { this.s = src; this.i = 0; }

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
        if (this.lit('+')) l = { t: 'bin', op: '+', opSp: [a, this.i], l, r: this.term() };
        else if (this.lit('-')) l = { t: 'bin', op: '-', opSp: [a, this.i], l, r: this.term() };
        else return l;
      }
    }

    term() {
      let l = this.power();
      for (;;) {
        const a = this.mark();
        if (this.lit('**')) l = { t: 'bin', op: '^', opSp: [a, this.i], l, r: this.power() };
        else if (this.lit('*')) l = { t: 'bin', op: '*', opSp: [a, this.i], l, r: this.power() };
        else if (this.lit('/')) l = { t: 'bin', op: '/', opSp: [a, this.i], l, r: this.power() };
        else if (this.lit('%')) l = { t: 'bin', op: '%', opSp: [a, this.i], l, r: this.power() };
        else return l;
      }
    }

    power() {
      const base = this.unary();
      const a = this.mark();
      if (this.lit('**') || this.lit('^')) {
        return { t: 'bin', op: '^', opSp: [a, this.i], l: base, r: this.power() };
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
      return /^\d/.test(rest) || rest[0] === '%' || rest[0] === '(' || /^[fF](?![a-z])/.test(rest);
    }

    primary() {
      const a = this.mark();
      if (this.end()) this.fail('unexpected end of expression');

      if (this.peek() === '{') return this.group();
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
        const node = { t: 'paren', v: inner, brk: [openSp, [cA, this.i]], sp: [a, this.i] };
        return this.maybeDice(node, a);
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
      if (this.lit('%')) {
        sides = { t: 'num', v: 100, sp: [sA, this.i], pct: true };
      } else if (/^[fF](?![a-z])/.test(this.s.slice(this.i))) {
        this.i++;
        let variant = 2;
        if (this.s[this.i] === '.') {
          this.i++;
          const v = this.digits();
          if (v === null) this.fail('expected a fudge variant, e.g. dF.1');
          variant = v;
        }
        sides = { t: 'fudge', variant, sp: [sA, this.i] };
      } else if (this.lit('(')) {
        sides = this.expr();
        if (!this.lit(')')) this.fail('expected ")" after computed sides');
      } else {
        const v = this.number();
        if (v === null) this.fail('expected the number of sides after "d"');
        sides = { t: 'num', v, sp: [sA, this.i] };
      }
      const coreEnd = this.i;
      const mods = this.modifiers();
      return { t: 'dice', qty, sides, mods, core: [a, coreEnd], sp: [a, this.i] };
    }

    group() {
      const a = this.mark();
      this.lit('{');
      const openSp = [a, this.i];
      const subs = [this.expr()];
      const commas = [];
      for (;;) {
        const cA = this.mark();
        if (!this.lit(',')) break;
        commas.push([cA, this.i]);
        subs.push(this.expr());
      }
      const bA = this.mark();
      if (!this.lit('}')) this.fail('expected "}" to close the group');
      const mods = this.modifiers();
      return {
        t: 'group', subs, mods, commas,
        brk: [openSp, [bA, bA + 1]], core: [a, bA + 1], sp: [a, this.i]
      };
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

    /* ---------------------------------------------------------- modifiers */
    modifiers() {
      const mods = [];
      for (;;) {
        const m = this.modifier();
        if (!m) return mods;
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

      // -- exploding --------------------------------------------------------
      if (this.lit('!!p')) return this.fin(start, { t: 'explode', compound: true, pen: true, cp: this.cpAny() });
      if (this.lit('!p')) return this.fin(start, { t: 'explode', compound: false, pen: true, cp: this.cpAny() });
      if (this.lit('!!')) return this.fin(start, { t: 'explode', compound: true, pen: false, cp: this.cpAny() });
      if (this.lit('!')) return this.fin(start, { t: 'explode', compound: false, pen: false, cp: this.cpAny() });

      // Dice Maiden aliases: ie6 explodes indefinitely on >=6, e6 explodes once
      if (this.lit('ie')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'explode', compound: false, pen: false, alias: true, cp: { op: '>=', v: n } });
      }
      if (this.lit('e')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'explode', compound: false, pen: false, once: true, alias: true, cp: { op: '>=', v: n } });
      }

      // -- reroll -----------------------------------------------------------
      if (this.lit('ro')) return this.fin(start, { t: 'reroll', once: true, cp: this.cpAny() });
      if (this.lit('r')) return this.fin(start, { t: 'reroll', once: false, cp: this.cpAny() });

      // -- unique -----------------------------------------------------------
      if (this.lit('uo')) return this.fin(start, { t: 'unique', once: true, cp: this.cpAny() });
      if (this.lit('u')) return this.fin(start, { t: 'unique', once: false, cp: this.cpAny() });

      // -- keep / drop ------------------------------------------------------
      if (this.lit('kh')) return this.fin(start, { t: 'keep', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('kl')) return this.fin(start, { t: 'keep', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('k')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'keep', end: 'h', n });
      }
      if (this.lit('dh')) return this.fin(start, { t: 'drop', end: 'h', n: this.digits() ?? 1 });
      if (this.lit('dl')) return this.fin(start, { t: 'drop', end: 'l', n: this.digits() ?? 1 });
      if (this.lit('d')) {
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'drop', end: 'l', n });
      }

      // -- criticals --------------------------------------------------------
      if (this.lit('cs')) return this.fin(start, { t: 'critSuccess', cp: this.cpAny() });
      if (this.lit('cf')) return this.fin(start, { t: 'critFail', cp: this.cpAny() });

      // -- successes / failures ---------------------------------------------
      if (this.lit('f')) {
        let cp = this.comparePoint();
        if (!cp) {                                  // Dice Maiden alias: f1 == f<=1
          const n = this.digits();
          if (n === null) return back();
          cp = { op: '<=', v: n };
          return this.fin(start, { t: 'failure', alias: true, cp });
        }
        return this.fin(start, { t: 'failure', cp });
      }
      if (this.lit('t')) {                       // Dice Maiden alias: t8
        const n = this.digits();
        return n === null ? back() : this.fin(start, { t: 'target', alias: true, cp: { op: '>=', v: n } });
      }

      // -- sorting ----------------------------------------------------------
      if (this.word('sa')) return this.fin(start, { t: 'sort', dir: 'a' });
      if (this.word('sd')) return this.fin(start, { t: 'sort', dir: 'd' });
      if (this.word('s')) return this.fin(start, { t: 'sort', dir: 'a' });

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

  /* Only these sizes have a standard solid: d4/d6/d8/d12/d20 are the Platonic
     solids, d10 is a pentagonal trapezohedron, d100 a zocchihedron, d2 a coin.
     Fudge dice and any other size have no die to draw, so they fall back to a
     plain value chip rather than inventing a shape. */
  const SOLIDS = { 2: 'd2', 4: 'd4', 6: 'd6', 8: 'd8', 10: 'd10', 12: 'd12', 20: 'd20', 100: 'd100' };
  const shapeFor = (sides, fudge) => fudge ? null : (SOLIDS[sides] || null);

  /** the digits shown on the face; Fudge dice read as -, 0, + */
  function faceText(v, fudge) {
    if (!fudge) return fmt(v);
    return v > 0 ? '+' : (v < 0 ? '−' : '0');
  }

  function dieHTML(r, shape, fudge) {
    const cls = ['die', 's-' + shape].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const title = (r.tags.length ? r.tags.join(', ') : 'natural') +
      (r.dropped ? ', dropped' : '') +
      (r.from !== null && r.from !== undefined ? ', was ' + fmt(r.from) : '');

    const face = faceText(r.v, fudge);
    const size = face.length >= 3 ? ' v3' : (face.length === 2 ? ' v2' : '');

    // one corner slot: a re-rolled die shows what it was, otherwise mark explosions
    let badge = '';
    if (r.from !== null && r.from !== undefined) badge = '<s>' + esc(faceText(r.from, fudge)) + '</s>';
    else if (r.tags.indexOf('exploded') >= 0) badge = '!';

    return '<span class="' + cls.join(' ') + '" title="' + esc(title) + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + esc(face) + '</span>' +
      (badge ? '<span class="diebadge">' + badge + '</span>' : '') +
      '</span>';
  }

  /** compact chip used when a roll has too many dice to draw as shapes */
  function chipHTML(r, fudge) {
    const cls = ['chip-die'].concat(r.tags);
    if (r.dropped) cls.push('dropped');
    const was = (r.from !== null && r.from !== undefined) ? '<s>' + esc(faceText(r.from, fudge)) + '</s>' : '';
    const bang = r.tags.indexOf('exploded') >= 0 ? '<sup>!</sup>' : '';
    return '<span class="' + cls.join(' ') + '">' + was + esc(faceText(r.v, fudge)) + bang + '</span>';
  }

  /* -------------------------------------------------------- result nodes */
  const NumResult = (v) => ({
    k: 'num', total: () => v, html: () => '<span class="r-num">' + fmt(v) + '</span>'
  });

  function BinResult(op, l, r) {
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
      html: (o) => l.html(o) + '<span class="r-op">' + esc(op) + '</span>' + r.html(o)
    };
  }

  const NegResult = (v) => ({
    k: 'neg', children: [v], total: () => -v.total(),
    html: (o) => '<span class="r-op">-</span>' + v.html(o)
  });

  const ParenResult = (v) => ({
    k: 'paren', inner: v, children: [v], total: () => v.total(),
    html: (o) => '<span class="r-brk">(</span>' + v.html(o) + '<span class="r-brk">)</span>'
  });

  const FuncResult = (name, args) => ({
    k: 'func', children: args,
    total: () => FUNCS[name].apply(null, args.map((a) => a.total())),
    html: (o) => '<span class="r-fn">' + name + '</span><span class="r-brk">(</span>' +
      args.map((a) => a.html(o)).join('<span class="r-op">,</span>') + '<span class="r-brk">)</span>'
  });

  /* --------------------------------------------------------- dice rolling */
  const makeDie = (sides, fudge) => fudge ? rng.int(-1, 1) : rng.int(1, sides);

  function rollDice(node, ctx) {
    const fudge = node.sides.t === 'fudge';
    let sides = 0;
    if (!fudge) {
      sides = Math.floor(node.sides.t === 'num' ? node.sides.v : evalNode(node.sides, ctx).total());
      if (!(sides >= 1)) throw new DiceError('a die needs at least 1 side (got ' + sides + ')');
      if (sides > LIMIT.sides) throw new DiceError('too many sides (max ' + LIMIT.sides + ')');
    }
    const qty = node.qty === null ? 1
      : Math.floor(node.qty.t === 'num' ? node.qty.v : evalNode(node.qty, ctx).total());
    if (!(qty >= 0)) throw new DiceError('dice quantity must be 0 or more (got ' + qty + ')');
    if (qty > LIMIT.qty) throw new DiceError('too many dice (max ' + LIMIT.qty + ')');
    ctx.dice += qty;
    if (ctx.dice > LIMIT.totalDice) throw new DiceError('too many dice in one expression');

    const dmin = fudge ? -1 : 1;
    const dmax = fudge ? 1 : sides;

    let rolls = [];
    for (let i = 0; i < qty; i++) rolls.push({ v: makeDie(sides, fudge), tags: [], from: null });

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
              const raw = makeDie(sides, fudge);
              last = raw;
              const val = m.pen ? raw - 1 : raw;
              if (m.compound) { r.v += val; tag(r, 'exploded'); }
              else out.push({ v: val, tags: ['exploded'], from: null });
              if (m.once) break;
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
              r.v = makeDie(sides, fudge);
              tag(r, 'rerolled');
              n++;
              if (m.once) break;
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
              r.v = makeDie(sides, fudge);
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

        case 'sort':
          rolls.sort((a, b) => m.dir === 'd' ? b.v - a.v : a.v - b.v);
          break;
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
      k: 'dice', rolls, fudge, sides, qty,
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
        const shape = shapeFor(this.sides, this.fudge);
        const parts = rolls.map((r) => (shape && !(o && o.plain))
          ? dieHTML(r, shape, this.fudge)
          : chipHTML(r, this.fudge));
        return '<span class="r-notn">' + esc(this.notation) + '</span>' +
          '<span class="r-brk">[</span>' + parts.join('') + '<span class="r-brk">]</span>';
      }
    };
  }

  /* -------------------------------------------------------- group results */
  function evalGroup(node, ctx) {
    const subs = node.subs.map((s) => evalNode(s, ctx));
    const mods = node.mods.slice().sort((a, b) => (ORDER[a.t] || 99) - (ORDER[b.t] || 99));
    const single = subs.length === 1;

    // In a single-expression group, keep/drop/target act on the individual dice.
    const dice = [];
    if (single) collectDice(subs[0], dice);

    const units = single
      ? dice.map((r) => ({
          ref: r, drop() { r.dropped = true; },
          get val() { return r.v; }, get dropped() { return !!r.dropped; }
        }))
      : subs.map((s) => {
          const u = { ref: s, dropped: false, drop() { u.dropped = true; } };
          Object.defineProperty(u, 'val', { get: () => s.total() });
          return u;
        });

    let successCp = null, failureCp = null;

    for (const m of mods) {
      switch (m.t) {
        case 'keep': {
          const live = units.filter((u) => !u.dropped);
          const order = live.slice().sort((a, b) => b.val - a.val);
          const keep = new Set(m.end === 'l' ? order.slice(-m.n) : order.slice(0, m.n));
          for (const u of live) if (!keep.has(u)) u.drop();
          break;
        }
        case 'drop': {
          const live = units.filter((u) => !u.dropped);
          const order = live.slice().sort((a, b) => b.val - a.val);
          for (const u of (m.end === 'h' ? order.slice(0, m.n) : order.slice(-m.n))) u.drop();
          break;
        }
        case 'target': successCp = m.cp; break;
        case 'failure': failureCp = m.cp; break;
        case 'sort':
          if (single) dice.sort((a, b) => m.dir === 'd' ? b.v - a.v : a.v - b.v);
          else subs.sort((a, b) => m.dir === 'd' ? b.total() - a.total() : a.total() - b.total());
          break;
      }
    }

    if (single && (successCp || failureCp)) {
      for (const r of dice) {
        if (r.dropped) continue;
        if (successCp && cpTest(successCp, r.v)) r.tags.push('success');
        else if (failureCp && cpTest(failureCp, r.v)) r.tags.push('failure');
      }
    }

    return {
      k: 'group', subs, units, children: subs, successMode: !!(successCp || failureCp),
      successes() {
        if (single) return dice.filter((r) => !r.dropped && r.tags.indexOf('success') >= 0).length;
        return units.filter((u) => !u.dropped && successCp && cpTest(successCp, u.val)).length;
      },
      failures() {
        if (single) return dice.filter((r) => !r.dropped && r.tags.indexOf('failure') >= 0).length;
        return units.filter((u) => !u.dropped && failureCp && cpTest(failureCp, u.val)).length;
      },
      total() {
        if (this.successMode) return this.successes() - this.failures();
        if (single) return subs[0].total();
        let s = 0;
        for (const u of units) if (!u.dropped) s += u.val;
        return s;
      },
      html(o) {
        const inner = subs.map((s, i) => {
          const dead = !single && units[i] && units[i].dropped;
          return '<span class="r-sub' + (dead ? ' dropped-sub' : '') + '">' + s.html(o) + '</span>';
        }).join('<span class="r-op">,</span>');
        return '<span class="r-brk">{</span>' + inner + '<span class="r-brk">}</span>';
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
      case 'paren': return ParenResult(evalNode(node.v, ctx));
      case 'bin': return BinResult(node.op, evalNode(node.l, ctx), evalNode(node.r, ctx));
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
    if (node.sides.t === 'fudge') sides = 'F' + (node.sides.variant === 2 ? '' : '.' + node.sides.variant);
    else if (node.sides.t === 'num') sides = plain(node.sides);
    else sides = '(' + plain(node.sides) + ')';     // computed sides keep their parentheses
    return q + 'd' + sides + node.mods.map(modText).join('');
  }

  function modText(m) {
    switch (m.t) {
      case 'min': return 'min' + m.n;
      case 'max': return 'max' + m.n;
      case 'explode':
        if (m.alias) return (m.once ? 'e' : 'ie') + m.cp.v;
        return (m.compound ? '!!' : '!') + (m.pen ? 'p' : '') + cpText(m.cp);
      case 'reroll': return (m.once ? 'ro' : 'r') + cpText(m.cp);
      case 'unique': return (m.once ? 'uo' : 'u') + cpText(m.cp);
      case 'keep': return 'k' + m.end + m.n;
      case 'drop': return 'd' + m.end + m.n;
      case 'target': return m.alias ? 't' + m.cp.v : cpText(m.cp);
      case 'failure': return m.alias ? 'f' + m.cp.v : 'f' + cpText(m.cp);
      case 'critSuccess': return 'cs' + cpText(m.cp);
      case 'critFail': return 'cf' + cpText(m.cp);
      case 'sort': return 's' + m.dir;
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
      case 'group': return '{' + node.subs.map(plain).join(', ') + '}' + node.mods.map(modText).join('');
      case 'fudge': return 'F' + (node.variant === 2 ? '' : '.' + node.variant);
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
        let how = m.compound
          ? 'roll again and fold the result into the same die'
          : 'roll an extra ' + d + ' and add it alongside';
        if (m.pen) how += ', subtracting 1 from every extra roll';
        const times = m.once ? ' Only one extra roll per die.' : ' Repeats as long as it keeps happening.';
        return [m.compound ? 'Compounding explode' : (m.pen ? 'Penetrating explode' : 'Exploding'),
                'When a ' + d + ' rolls ' + on + ', ' + how + '.' + times];
      }
      case 'reroll': return ['Re-roll',
        'Any ' + d + ' showing ' + cpPhrase(m.cp, 'its lowest face') + ' is re-rolled' +
        (m.once ? ' once (the new value stands).' : ' until it no longer qualifies.')];
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
      case 'sort': return ['Sort', 'Show the dice in ' + (m.dir === 'd' ? 'descending' : 'ascending') + ' order.'];
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

    const push = (sp, cls, row) => {
      if (!sp) return null;
      const id = row ? 'x' + (++uid) : null;
      spans.push({ a: sp[0], b: sp[1], cls, id });
      if (row) rows.push(Object.assign({ id, code: src.slice(sp[0], sp[1]) }, row));
      return id;
    };

    function diceTitle(node) {
      const s = node.sides;
      if (s.t === 'fudge') return 'Fudge / FATE dice';
      if (s.pct) return 'Percentile dice';
      return 'Dice roll';
    }

    function diceDesc(node) {
      const s = node.sides;
      const q = node.qty === null ? '1' : plain(node.qty);
      const many = q !== '1';
      const dieWord = many ? 'dice' : 'die';
      if (s.t === 'fudge') {
        return 'Roll ' + q + ' Fudge ' + dieWord + '. Each shows −1, 0 or +1 with equal chance.';
      }
      if (s.pct) return 'Roll ' + q + ' percentile ' + dieWord + ' (1–100), then sum.';
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

        case 'paren':
          push(node.brk[0], 't-brk', { title: 'Group', desc: 'Everything inside the parentheses is worked out first.', depth });
          walk(node.v, depth + 1);
          push(node.brk[1], 't-brk');
          break;

        case 'bin': {
          walk(node.l, depth);
          const [title, desc] = OP_NAMES[node.op] || ['Operator', ''];
          push(node.opSp, 't-op', { title, desc, depth });
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
          push(node.core, 't-dice', { title: diceTitle(node), desc: diceDesc(node), depth });
          if (node.qty && node.qty.t !== 'num') walk(node.qty, depth + 1);
          if (node.sides.t !== 'num' && node.sides.t !== 'fudge') walk(node.sides, depth + 1);
          for (const m of node.mods) {
            const [title, desc] = modExplain(m, many ? 'die' : 'die');
            push(m.sp, 't-mod', { title, desc, depth: depth + 1 });
          }
          break;
        }

        case 'group': {
          push(node.brk[0], 't-brk', {
            title: 'Roll group',
            desc: node.subs.length > 1
              ? 'Roll each of the ' + node.subs.length + ' expressions separately, then combine their totals. Group modifiers act on whole sub-rolls.'
              : 'A group around a single expression. Group modifiers act on every individual die inside it.',
            depth
          });
          node.subs.forEach((s, i) => {
            walk(s, depth + 1);
            if (node.commas[i]) push(node.commas[i], 't-op');
          });
          push(node.brk[1], 't-brk');
          for (const m of node.mods) {
            const [title, desc] = modExplain(m, 'sub-roll');
            push(m.sp, 't-mod', { title, desc: desc, depth: depth + 1 });
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

  /** Split off a `3x` repeat prefix and a `# label` suffix, then parse. */
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

    let ast;
    try {
      ast = new Parser(src).parse();
    } catch (e) {
      if (e instanceof DiceError && e.pos != null) e.pos += offset;
      throw e;
    }
    return { ast, repeat, repeatSp, label, labelSp, offset, src, trimmed: raw.trim(), notation: plain(ast) };
  }

  /** Everything the UI needs to highlight + explain an input string. */
  function inspect(input) {
    const p = parse(input);
    const d = describe(p.ast, p.src);
    const spans = d.spans.map((s) => ({ a: s.a + p.offset, b: s.b + p.offset, cls: s.cls, id: s.id }));
    const rows = d.rows.map((r) => Object.assign({}, r));

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
    for (let i = 0; i < p.repeat; i++) sets.push(evaluate(p.ast));
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
      for (let r = 0; r < p.repeat; r++) t += evaluate(p.ast).total();
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

  global.DiceEngine = { parse, inspect, evaluate, roll, analyse, fmt, esc, DiceError, LIMIT, FUNCS };
}(window));
