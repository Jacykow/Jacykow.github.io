/* ============================================================================
   Random Engine — UI layer
   RegExr-style: a live syntax-highlighted expression field, a result stack,
   and a tool drawer (Explain / Details / Reference / Saved) that stays in sync
   with the caret.
   ========================================================================== */
(function () {
  'use strict';

  const E = window.DiceEngine;
  const $ = (id) => document.getElementById(id);
  const esc = E.esc;

  const el = {
    ta: $('expr'), hl: $('hl'), wrap: $('editorWrap'), status: $('status'),
    notation: $('notation'), result: $('result'), rollBtn: $('rollBtn'),
    tabs: $('tabs'), explain: $('tab-explain'), details: $('tab-details'),
    reference: $('tab-reference'), saved: $('tab-saved'), toast: $('toast'),
    paneTools: $('paneTools'), drawer: $('drawerToggle'), refSide: $('refSide')
  };

  /* the one place the desktop/mobile split is decided */
  const wide = window.matchMedia('(min-width: 1000px)');

  /* dice-count thresholds where the result display steps down a size */
  const DENSITY = { dense: 18, denser: 60, plain: 240 };
  const LOG_MAX = 60;

  const DEFAULT_EXPR = '4d6dl1 # ability score';
  const LS_SAVED = 're.saved.v1';
  const LS_LAST = 're.last.v1';
  const LS_DRAWER = 're.drawer.v1';

  let state = {
    inspect: null,     // last successful DiceEngine.inspect()
    spans: [],         // spans actually painted (overlaps removed)
    error: null,
    log: [],           // [{roll, expanded}] newest first
    topIsLive: true,
    activeTab: 'explain',
    statsToken: 0,
    curRow: null,      // Explain row the caret last sat on
    hot: null          // token currently hovered, on any of the three surfaces
  };

  /* ======================================================== reference data */
  /* every size that has a solid of its own, for the gallery */
  const DICE_GALLERY = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 100];

  /* Each entry is [code, description, form].
       atom   — inserted where the caret is
       suffix — appended to the dice term or bracket the caret is in
       wrap   — wraps that term in a function
     The code is written with (_) standing for the expression it attaches to,
     so the reference shows placement rather than a bare fragment. */
  const REFERENCE = [
    ['Dice', [
      ['d20', 'one twenty-sided die', 'atom'],
      ['4d6', 'four six-sided dice, summed', 'atom'],
      ['(2+2)d6', 'computed quantity', 'atom'],
      ['3d(2*6)', 'computed number of sides', 'atom']
    ]],
    ['Exploding', [
      ['(_)!', 're-roll and add on the highest face', 'suffix'],
      ['(_)!>4', 'explode on anything over 4', 'suffix'],
      ['(_)!p', 'penetrating: extra dice take -1', 'suffix'],
      ['(_)e6', 'explode once on 6 or more', 'suffix'],
      ['(_)ie6', 'explode repeatedly on 6 or more', 'suffix']
    ]],
    ['Keep & drop', [
      ['(_)kh3', 'keep the highest 3', 'suffix'],
      ['(_)kl1', 'keep the lowest 1 (disadvantage)', 'suffix'],
      ['(_)dl1', 'drop the lowest 1', 'suffix'],
      ['(_)dh1', 'drop the highest 1', 'suffix']
    ]],
    ['Re-rolling', [
      ['(_)r', 're-roll 1s until they are not 1s', 'suffix'],
      ['(_)r<3', 're-roll anything under 3', 'suffix'],
      ['(_)ro1', 're-roll 1s exactly once', 'suffix'],
      ['(_)u', 'force every die to be unique', 'suffix'],
      ['(_)uo', 're-roll duplicates once', 'suffix']
    ]],
    ['Successes', [
      ['(_)>=8', 'count each 8+ as a success', 'suffix'],
      ['(_)f<=1', 'each 1 or less cancels a success', 'suffix'],
      ['(_)t8', 'alias for >=8', 'suffix'],
      ['(_)cs>=19', 'flag 19+ as a critical success', 'suffix'],
      ['(_)cf<=2', 'flag 2 or less as a critical fail', 'suffix']
    ]],
    ['Clamp', [
      ['(_)min2', 'treat anything below 2 as 2', 'suffix'],
      ['(_)max5', 'treat anything above 5 as 5', 'suffix']
    ]],
    ['Bracket groups', [
      ['(3d6+2d8)kh3', 'keep the best 3 dice across the group', 'atom'],
      ['(4d6+2d10)dl2', 'drop the worst 2 overall', 'atom'],
      ['(2d6+3d8)>=5', 'count every die of 5 or more', 'atom'],
      ['(2d20+2d12)kl1', 'keep the single worst die', 'atom']
    ]],
    ['Maths', [
      ['(_)+2', 'add', 'suffix'],
      ['(_)-2', 'subtract', 'suffix'],
      ['(_)*2', 'multiply', 'suffix'],
      ['(_)/2', 'divide', 'suffix'],
      ['(_)%2', 'remainder', 'suffix'],
      ['(_)^2', 'raise to a power', 'suffix']
    ]],
    ['Functions', [
      ['floor(_)', 'round down', 'wrap'],
      ['ceil(_)', 'round up', 'wrap'],
      ['round(_)', 'round to nearest', 'wrap'],
      ['abs(_)', 'absolute value', 'wrap'],
      ['sqrt(_)', 'square root', 'wrap'],
      ['sign(_)', 'sign: -1, 0 or 1', 'wrap'],
      ['log(_)', 'natural logarithm', 'wrap'],
      ['exp(_)', 'e to the power of', 'wrap'],
      ['sin(_)', 'sine', 'wrap'],
      ['cos(_)', 'cosine', 'wrap'],
      ['tan(_)', 'tangent', 'wrap'],
      ['max(_, 1)', 'the largest argument', 'wrap'],
      ['min(_, 1)', 'the smallest argument', 'wrap'],
      ['pow(_, 2)', 'raise to a power', 'wrap']
    ]],
    ['Whole roll', [
      ['6x ', 'repeat the expression 6 times', 'prefix'],
      [' # note', 'label, ignored by the maths', 'append']
    ]],
    ['Comparisons', [
      ['= != < > <= >=', 'usable after !, r, u, f, cs, cf', null]
    ]]
  ];

  /* ============================================================== helpers */
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.toast.classList.remove('on'), 1600);
  }

  const store = {
    read(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    }
  };

  /* ==================================================== syntax highlighting */
  function paint() {
    const src = el.ta.value;
    const spans = state.error ? [] : (state.inspect ? state.inspect.spans : []);
    const painted = [];
    let out = '', pos = 0;

    for (const s of spans) {
      if (s.a < pos || s.b > src.length) continue;   // nested inside an earlier span
      if (s.a > pos) out += esc(src.slice(pos, s.a));
      out += '<span class="' + s.cls + '"' + (s.id ? ' data-x="' + s.id + '"' : '') + '>' +
        esc(src.slice(s.a, s.b)) + '</span>';
      painted.push(s);
      pos = s.b;
    }
    out += esc(src.slice(pos));
    el.hl.innerHTML = out || '<span class="t-op"> </span>';
    state.spans = painted;
    el.hl.scrollLeft = el.ta.scrollLeft;
  }

  /** the smallest painted span containing the caret */
  function spanAtCaret() {
    const c = el.ta.selectionStart;
    let best = null;
    for (const s of state.spans) {
      if (!s.id) continue;
      if (c >= s.a && c <= s.b) {
        if (!best || (s.b - s.a) < (best.b - best.a)) best = s;
      }
    }
    return best;
  }

  function highlightSpan(id) {
    el.hl.querySelectorAll('.lit').forEach((n) => n.classList.remove('lit'));
    if (!id) return;
    const n = el.hl.querySelector('[data-x="' + id + '"]');
    if (n) n.classList.add('lit');
  }

  /* ---------------------------------------------------------- hover link
     The expression, the Explain list and the rolled dice all tag their pieces
     with the same data-x, so lighting one lights the other two. */
  function setHot(id) {
    if (state.hot === id) return;
    state.hot = id;
    document.querySelectorAll('.hot').forEach((n) => n.classList.remove('hot'));
    if (!id) return;
    const sel = '[data-x="' + id + '"]';
    el.hl.querySelectorAll(sel).forEach((n) => n.classList.add('hot'));
    el.explain.querySelectorAll('.exrow' + sel).forEach((n) => n.classList.add('hot'));
    el.result.querySelectorAll('.r-term' + sel + ', .r-grp' + sel).forEach((n) => n.classList.add('hot'));
  }

  /** the expression is a textarea, so hit-test the highlight layer by hand */
  function spanAtPoint(x, y) {
    let best = null;
    el.hl.querySelectorAll('[data-x]').forEach((n) => {
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        if (!best || r.width < best.w) best = { id: n.getAttribute('data-x'), w: r.width };
      }
    });
    return best ? best.id : null;
  }

  /**
   * Mark the token under the caret, in the editor and in the Explain list.
   * `chase` scrolls the list to that row — only ever from a real caret move, and
   * only when the token actually changed. Doing it on every call fought the user
   * for control of the scrollbar.
   */
  function syncCaret(chase) {
    const s = spanAtCaret();
    const id = s ? s.id : null;
    highlightSpan(id);
    el.explain.querySelectorAll('.exrow.cur').forEach((n) => n.classList.remove('cur'));
    if (!id) { state.curRow = null; return; }

    const row = el.explain.querySelector('.exrow[data-x="' + id + '"]');
    if (!row) { state.curRow = null; return; }
    row.classList.add('cur');

    if (chase && id !== state.curRow) {
      const pt = el.explain, top = row.offsetTop, bot = top + row.offsetHeight;
      if (top < pt.scrollTop || bot > pt.scrollTop + pt.clientHeight) {
        pt.scrollTop = top - pt.clientHeight / 2 + row.offsetHeight / 2;
      }
    }
    state.curRow = id;
  }

  /* ============================================================== explain */
  function renderExplain() {
    if (state.error) {
      el.explain.innerHTML = '<div class="muted">' + esc(state.error.message) + '</div>';
      return;
    }
    const rows = state.inspect ? state.inspect.rows : [];
    if (!rows.length) { el.explain.innerHTML = '<div class="muted">type an expression above</div>'; return; }

    el.explain.innerHTML = rows.map((r) =>
      '<div class="exrow" data-x="' + r.id + '">' +
        '<code>' + esc(r.code.trim() || r.code) + '</code>' +
        '<div class="t">' + esc(r.title) + '</div>' +
        '<div class="d">' + esc(r.desc) + '</div>' +
      '</div>'
    ).join('');

    state.curRow = null;
    el.explain.querySelectorAll('.exrow').forEach((row) => {
      const id = row.getAttribute('data-x');
      row.addEventListener('mouseenter', () => setHot(id));
      row.addEventListener('mouseleave', () => setHot(null));
      row.addEventListener('click', () => {
        const s = state.spans.find((x) => x.id === id);
        if (!s) return;
        el.ta.focus();
        el.ta.setSelectionRange(s.a, s.b);
        syncCaret(true);
      });
    });
  }

  /* =============================================================== result */
  function totalText(roll) {
    return roll.successMode
      ? E.fmt(roll.total) + (Math.abs(roll.total) === 1 ? ' hit' : ' hits')
      : E.fmt(roll.total);
  }

  /** history entries below the newest collapse to a single line */
  function lineHTML(roll, idx) {
    // the label replaces the expression when there is one; showing both is noise
    const name = roll.label
      ? '<span class="ll">' + esc(roll.label) + '</span>'
      : '<span class="lx">' + esc(roll.notation) + '</span>';
    return '<div class="line" data-open="' + idx + '" title="show the breakdown">' +
      '<span class="lt">' + esc(totalText(roll)) + '</span>' + name +
      '<span class="ldice">' + roll.sets[0].html(roll.diceCount > DENSITY.plain ? { plain: true } : null) + '</span>' +
      '<span class="lm">' + esc(roll.time) + '</span>' +
    '</div>';
  }

  function cardHTML(roll, live, idx) {
    const many = roll.sets.length > 1;

    // Dice are drawn as shapes; they shrink as the count climbs and fall back to
    // plain chips past the point where thousands of SVG nodes would stall typing.
    const n = roll.diceCount;
    const opts = n > DENSITY.plain ? { plain: true } : null;
    const density = opts ? ' plain'
      : n > DENSITY.denser ? ' denser'
      : n > DENSITY.dense ? ' dense' : '';

    let rows;
    if (many) {
      rows = roll.sets.map((s, i) =>
        '<div class="setrow"><span class="i">#' + (i + 1) + '</span>' +
          '<span class="body">' + s.html(opts) + '</span>' +
          '<span class="st">' + E.fmt(s.total()) + '</span></div>'
      ).join('');
    } else {
      rows = '<div class="setrow"><span class="body">' + roll.sets[0].html(opts) + '</span></div>';
    }

    let tally = '';
    if (roll.successMode) {
      tally = '<div class="tally"><b>' + roll.successes + '</b> success' +
        (roll.successes === 1 ? '' : 'es') +
        (roll.failures ? ' &minus; <i>' + roll.failures + '</i> failure' + (roll.failures === 1 ? '' : 's') : '') +
        ' = ' + E.fmt(roll.total) + '</div>';
    }

    const meta = [];
    if (many) meta.push(roll.sets.length + ' sets, summed');
    if (live) meta.push('<span class="pulse">live &mdash; Enter to keep</span>');
    else meta.push(roll.time);
    meta.push('<button class="again" data-again="' + idx + '">roll again</button>');

    return '<div class="card' + (live ? ' live' : '') + '" data-card="' + idx + '">' +
      '<div class="top">' +
        '<div class="total">' + esc(totalText(roll)) + '</div>' +
        '<div class="meta">' +
          '<div class="expr">' + esc(roll.notation) + '</div>' +
          (roll.label ? '<div class="lbl"># ' + esc(roll.label) + '</div>' : '') +
          '<div class="sub">' + meta.join('<span>&middot;</span>') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="rows' + density + '">' + rows + '</div>' + tally +
    '</div>';
  }

  function renderResult() {
    if (!state.log.length) {
      el.result.innerHTML = '<div class="muted">nothing rolled yet</div>';
      return;
    }
    // Only the newest entry keeps the full breakdown; the rest are one-liners
    // until the user opens them.
    el.result.innerHTML = state.log.map((e, i) =>
      (i === 0 || e.expanded)
        ? cardHTML(e.roll, i === 0 && state.topIsLive, i)
        : lineHTML(e.roll, i)
    ).join('');
    drawTrees(el.result);
  }

  function makeRoll() {
    let roll;
    try { roll = E.roll(el.ta.value); }
    catch (e) { return null; }
    roll.time = new Date().toLocaleTimeString();
    return { roll, expanded: false };
  }

  /** re-roll the live (top) card in place */
  function refreshLive() {
    const e = makeRoll();
    if (!e) return;
    if (state.topIsLive && state.log.length) state.log[0] = e;
    else { state.log.unshift(e); state.topIsLive = true; }
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    renderResult();
  }

  /** commit: freeze what is on screen and roll a fresh live card on top */
  function commitRoll() {
    if (state.error) { flashError(); return; }
    const frozen = makeRoll();
    if (!frozen) { flashError(); return; }
    if (state.topIsLive && state.log.length) state.log.shift();   // drop the preview
    state.log.unshift(frozen);
    state.topIsLive = false;
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    renderResult();
    el.result.scrollTop = 0;
  }

  function flashError() {
    el.wrap.classList.remove('bad');
    void el.wrap.offsetWidth;
    el.wrap.classList.add('bad');
  }

  /* ============================================================== details */
  function renderDetails() {
    const token = ++state.statsToken;
    if (state.error || !el.ta.value.trim()) {
      el.details.innerHTML = '<div class="muted">' +
        (state.error ? 'fix the expression to see its distribution' : 'type an expression above') + '</div>';
      return;
    }
    el.details.innerHTML = '<div class="muted">simulating&hellip;</div>';

    setTimeout(() => {
      if (token !== state.statsToken) return;
      let s;
      try {
        // Adaptive sample size: aim for roughly 150ms of work.
        const t0 = performance.now();
        E.analyse(el.ta.value, 100);
        const per = Math.max((performance.now() - t0) / 100, 0.0005);
        const n = Math.max(400, Math.min(20000, Math.floor(150 / per)));
        s = E.analyse(el.ta.value, n);
      } catch (err) {
        el.details.innerHTML = '<div class="muted">' + esc(err.message) + '</div>';
        return;
      }
      if (token !== state.statsToken) return;
      el.details.innerHTML = statsHTML(s);
    }, 0);
  }

  function statsHTML(s) {
    const cells = [
      ['min', E.fmt(s.min)], ['mean', s.mean.toFixed(2)], ['median', E.fmt(s.median)],
      ['max', E.fmt(s.max)], ['std dev', s.stdev.toFixed(2)],
      ['10th %', E.fmt(s.p10)], ['90th %', E.fmt(s.p90)], ['samples', s.n.toLocaleString()]
    ];
    const grid = '<div class="statgrid">' + cells.map(([k, v]) =>
      '<div class="stat"><b>' + esc(v) + '</b><i>' + esc(k) + '</i></div>').join('') + '</div>';

    // histogram
    const span = s.max - s.min;
    const bins = Math.max(1, Math.min(60, Math.round(span) + 1));
    const w = span === 0 ? 1 : span / bins;
    const counts = new Array(bins).fill(0);
    for (const t of s.totals) {
      let b = span === 0 ? 0 : Math.floor((t - s.min) / w);
      if (b >= bins) b = bins - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    const peak = Math.max.apply(null, counts) || 1;
    const bars = counts.map((c, i) => {
      const lo = s.min + i * w, hi = lo + w;
      const pct = ((c / s.n) * 100).toFixed(1);
      return '<div class="bar" style="height:' + Math.max(1, (c / peak) * 100) + '%" title="' +
        E.fmt(Math.round(lo * 100) / 100) + (w > 1 ? '–' + E.fmt(Math.round(hi * 100) / 100) : '') +
        ': ' + pct + '%"></div>';
    }).join('');

    return grid + '<div class="hist">' + bars + '</div>' +
      '<div class="histaxis"><span>' + E.fmt(s.min) + '</span>' +
      '<span>distribution of the total</span><span>' + E.fmt(s.max) + '</span></div>';
  }

  /* ============================================================ reference */
  /** the dice gallery: every size that has a solid of its own, drawn */
  function galleryHTML() {
    const dice = DICE_GALLERY.map((n) => {
      const shape = E.shapeFor(n);
      return '<div class="refdie" data-ins="d' + n + '" title="click to insert d' + n + '">' +
        '<span class="die s-' + shape + '">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true"><use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval">' + n + '</span>' +
        '</span><code>d' + n + '</code></div>';
    }).join('');
    return '<div class="refgroup"><h3>The dice</h3><div class="refdice">' + dice + '</div>' +
      '<div class="refrow"><span>Sizes without a solid of their own borrow the nearest one.</span></div></div>';
  }

  function renderReference() {
    const html = '<div class="refgrid">' + galleryHTML() + REFERENCE.map(([name, items]) =>
      '<div class="refgroup"><h3>' + esc(name) + '</h3>' + items.map(([code, desc, form]) => {
        // entries with no placement rule are documentation only, not insertable
        const tag = form
          ? ' data-ins="' + esc(code) + '" data-form="' + form + '"'
          : ' class="inert"';
        return '<div class="refrow"><code' + tag + '>' + esc(code) + '</code>' +
          '<span>' + esc(desc) + '</span></div>';
      }).join('') + '</div>').join('') + '</div>';

    // wide screens get the permanent left rail, narrow ones the drawer tab
    const host = wide.matches ? el.refSide : el.reference;
    const other = wide.matches ? el.reference : el.refSide;
    other.innerHTML = '';
    host.innerHTML = html;

    const HINT = {
      atom: 'click to insert at the caret',
      suffix: 'click to attach to the term the caret is in',
      wrap: 'click to wrap the term the caret is in',
      prefix: 'click to add to the front of the expression',
      append: 'click to add to the end of the expression'
    };
    host.querySelectorAll('[data-ins]').forEach((c) => {
      const form = c.getAttribute('data-form') || 'atom';
      c.title = HINT[form] || HINT.atom;
      c.addEventListener('click', () => applySnippet(c.getAttribute('data-ins'), form));
    });
  }

  function insertAtCaret(text) {
    const t = el.ta;
    const a = t.selectionStart, b = t.selectionEnd;
    t.value = t.value.slice(0, a) + text + t.value.slice(b);
    t.focus();
    t.setSelectionRange(a + text.length, a + text.length);
    onInput();
  }

  /* ------------------------------------------------- placement-aware insert
     Reference snippets say where they attach: `(_)kh3` hangs off a term,
     `floor(_)` wraps one. Find the innermost dice term or bracket the caret
     sits in and act on that, so clicking builds on what is already typed. */
  function targetSpan() {
    if (!state.inspect) return null;
    const p = state.inspect.parsed, off = p.offset;
    const pos = Math.max(0, Math.min(el.ta.selectionStart, el.ta.value.length) - off);
    let best = null, last = null;

    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.sp && (n.t === 'dice' || n.t === 'group' || n.t === 'paren')) {
        if (!last || n.sp[1] > last.sp[1]) last = n;
        if (pos >= n.sp[0] && pos <= n.sp[1] &&
            (!best || (n.sp[1] - n.sp[0]) < (best.sp[1] - best.sp[0]))) best = n;
      }
      for (const k of ['l', 'r', 'v', 'sub', 'qty', 'sides']) walk(n[k]);
      if (n.args) n.args.forEach(walk);
    }(p.ast));

    const node = best || last;
    // nothing dice-like to hang off: treat the whole expression as the target
    if (!node) return { a: off, b: el.ta.value.length, whole: true };
    return { a: node.sp[0] + off, b: node.sp[1] + off, whole: false };
  }

  function applySnippet(code, form) {
    const t = el.ta;
    if (!form || form === 'atom') return insertAtCaret(code.replace(/\(_\)/g, ''));

    if (form === 'prefix') {
      t.value = code + t.value;
      t.focus(); t.setSelectionRange(code.length, code.length);
      return onInput();
    }
    if (form === 'append') {
      const at = t.value.length;
      t.value = t.value + code;
      t.focus(); t.setSelectionRange(at + code.length, at + code.length);
      return onInput();
    }

    const sp = targetSpan();
    if (!sp) return insertAtCaret(code.replace(/\(_\)/g, ''));
    const inner = t.value.slice(sp.a, sp.b);

    let replacement, caret;
    if (form === 'suffix') {
      // modifiers only bind to a die or a bracket, so bracket anything else
      const tail = code.replace(/^\(_\)/, '');
      const base = sp.whole ? '(' + inner + ')' : inner;
      replacement = base + tail;
      caret = sp.a + replacement.length;
    } else {                                   // wrap
      replacement = code.replace('_', inner);
      caret = sp.a + replacement.length;
    }

    t.value = t.value.slice(0, sp.a) + replacement + t.value.slice(sp.b);
    t.focus();
    t.setSelectionRange(caret, caret);
    onInput();
  }

  /* ------------------------------------------------------------ sum tree
     Every summing node carries data-sum. Measure where each one sits over the
     dice and draw it as a bracket underneath, innermost nearest the dice. */
  const SUM_ROW = 17;
  function drawTrees(root) {
    root.querySelectorAll('.setrow .body').forEach((body) => {
      const nodes = Array.prototype.slice.call(body.querySelectorAll('[data-sum]'));
      if (!nodes.length) return;
      const base = body.getBoundingClientRect();
      const items = nodes.map((n) => {
        let depth = 0, p = n.parentElement;
        while (p && p !== body) {
          if (p.hasAttribute && p.hasAttribute('data-sum')) depth++;
          p = p.parentElement;
        }
        const r = n.getBoundingClientRect();
        return { depth, left: r.left - base.left, width: r.width, sum: n.getAttribute('data-sum') };
      });
      const maxDepth = items.reduce((a, i) => Math.max(a, i.depth), 0);

      const layer = document.createElement('div');
      layer.className = 'sumtree';
      layer.style.height = ((maxDepth + 1) * SUM_ROW) + 'px';
      for (const it of items) {
        const bar = document.createElement('div');
        bar.className = 'sumbar';
        bar.style.left = it.left + 'px';
        bar.style.width = Math.max(it.width, 20) + 'px';
        bar.style.top = ((maxDepth - it.depth) * SUM_ROW) + 'px';
        bar.innerHTML = '<span class="sumval">' + esc(it.sum) + '</span>';
        layer.appendChild(bar);
      }
      body.appendChild(layer);
    });
  }

  /* ================================================================ saved */
  function renderSaved() {
    const items = store.read(LS_SAVED, []);
    if (!items.length) {
      el.saved.innerHTML = '<div class="muted">nothing saved yet &mdash; hit Save (or Ctrl+S) to keep the current expression</div>';
      return;
    }
    el.saved.innerHTML = items.map((it, i) =>
      '<div class="savedrow" data-i="' + i + '">' +
        '<span class="nm">' + esc(it.name) + '</span>' +
        '<code>' + esc(it.expr) + '</code>' +
        '<button class="del" data-del="' + i + '" title="delete">&times;</button>' +
      '</div>').join('');

    el.saved.querySelectorAll('.savedrow').forEach((row) => {
      row.addEventListener('click', (ev) => {
        if (ev.target.hasAttribute('data-del')) return;
        const it = store.read(LS_SAVED, [])[+row.getAttribute('data-i')];
        if (it) { el.ta.value = it.expr; onInput(); commitRoll(); }
      });
    });
    el.saved.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const items = store.read(LS_SAVED, []);
        items.splice(+b.getAttribute('data-del'), 1);
        store.write(LS_SAVED, items);
        renderSaved();
      });
    });
  }

  function saveCurrent() {
    const expr = el.ta.value.trim();
    if (!expr) return;
    const name = prompt('Save this expression as:', state.inspect && state.inspect.parsed.label || expr);
    if (name === null) return;
    const items = store.read(LS_SAVED, []);
    items.unshift({ name: name.trim() || expr, expr });
    store.write(LS_SAVED, items.slice(0, 60));
    renderSaved();
    switchTab('saved');
    toast('saved');
  }

  /* =============================================================== drawer */
  function setDrawer(collapsed) {
    el.paneTools.classList.toggle('collapsed', collapsed);
    el.drawer.setAttribute('aria-expanded', String(!collapsed));
    el.drawer.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
    store.write(LS_DRAWER, collapsed);
  }

  /* ================================================================= tabs */
  function switchTab(name) {
    state.activeTab = name;
    el.tabs.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', b.getAttribute('data-tab') === name));
    ['explain', 'details', 'reference', 'saved'].forEach((n) =>
      $('tab-' + n).classList.toggle('on', n === name));
    if (name === 'details') renderDetails();
  }

  /* ================================================================ input */
  let detailsTimer = null;

  function onInput() {
    // Single-line editor. A newline means the user hit return — on desktop keydown
    // already handled it, but some phone keyboards only ever insert the character.
    let submitted = false;
    if (el.ta.value.indexOf('\n') >= 0) {
      const p = el.ta.selectionStart;
      el.ta.value = el.ta.value.replace(/\n/g, '');
      const c = Math.max(0, p - 1);
      el.ta.setSelectionRange(c, c);
      submitted = true;
    }

    const raw = el.ta.value;
    store.write(LS_LAST, raw);

    if (!raw.trim()) {
      state.inspect = null; state.error = null;
      el.status.textContent = ' ';
      el.status.classList.remove('err');
      el.notation.textContent = '';
      el.wrap.classList.remove('bad', 'ok');
      paint(); renderExplain();
      if (state.activeTab === 'details') renderDetails();
      return;
    }

    try {
      state.inspect = E.inspect(raw);
      state.error = null;
      const p = state.inspect.parsed;
      el.notation.textContent = (p.repeat > 1 ? p.repeat + '× ' : '') + state.inspect.notation;
      el.status.classList.remove('err');
      el.status.textContent = summarise(p);
      el.wrap.classList.remove('bad');
      el.wrap.classList.add('ok');
    } catch (err) {
      state.error = err;
      state.inspect = null;
      el.notation.textContent = '';
      el.status.classList.add('err');
      el.status.textContent = errorLine(err, raw);
      el.wrap.classList.add('bad');
      el.wrap.classList.remove('ok');
    }

    paint();
    renderExplain();
    syncCaret(true);

    if (!state.error) refreshLive();
    if (submitted) commitRoll();

    clearTimeout(detailsTimer);
    if (state.activeTab === 'details') detailsTimer = setTimeout(renderDetails, 300);
  }

  function summarise(p) {
    const bits = [];
    if (p.repeat > 1) bits.push(p.repeat + ' sets');
    if (p.label) bits.push('label "' + p.label + '"');
    return bits.length ? '✓  ' + bits.join('  ·  ') : '✓  ready';
  }

  function errorLine(err, raw) {
    if (typeof err.pos !== 'number') return '✗  ' + err.message;
    const trimOffset = raw.length - raw.replace(/^\s+/, '').length;
    const col = Math.max(0, err.pos + trimOffset);
    return '✗  ' + err.message + '  (at position ' + (col + 1) + ')';
  }

  /* ================================================================ wiring */
  function init() {
    renderReference();
    renderSaved();

    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    el.ta.value = hash || store.read(LS_LAST, '') || DEFAULT_EXPR;

    el.ta.addEventListener('input', onInput);
    el.ta.addEventListener('scroll', () => { el.hl.scrollLeft = el.ta.scrollLeft; });
    ['keyup', 'click', 'select', 'focus'].forEach((ev) =>
      el.ta.addEventListener(ev, () => setTimeout(() => syncCaret(true), 0)));

    el.ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitRoll(); return; }
      if (ev.key === 'Escape') { el.ta.value = ''; onInput(); return; }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveCurrent(); }
    });

    el.rollBtn.addEventListener('click', () => { commitRoll(); el.ta.focus(); });

    el.wrap.addEventListener('mousemove', (ev) => setHot(spanAtPoint(ev.clientX, ev.clientY)));
    el.wrap.addEventListener('mouseleave', () => setHot(null));
    el.result.addEventListener('mouseover', (ev) => {
      const n = ev.target.closest('[data-x]');
      setHot(n ? n.getAttribute('data-x') : null);
    });
    el.result.addEventListener('mouseleave', () => setHot(null));

    wide.addEventListener('change', () => {
      renderReference();
      if (!wide.matches && state.activeTab === 'reference') switchTab('explain');
      else if (wide.matches && state.activeTab === 'reference') switchTab('explain');
    });

    el.result.addEventListener('click', (ev) => {
      const again = ev.target.closest('[data-again]');
      if (again) {
        const e = state.log[+again.getAttribute('data-again')];
        if (e) { el.ta.value = e.roll.input; onInput(); commitRoll(); }
        return;
      }
      const open = ev.target.closest('[data-open]');
      if (open) {
        const e = state.log[+open.getAttribute('data-open')];
        if (e) { e.expanded = true; renderResult(); }
        return;
      }
      // clicking an expanded card anywhere inert folds it back up
      const card = ev.target.closest('[data-card]');
      if (card && !ev.target.closest('button, a, input')) {
        const i = +card.getAttribute('data-card');
        if (i > 0 && state.log[i]) { state.log[i].expanded = false; renderResult(); }
      }
    });
    $('btnClear').addEventListener('click', () => {
      state.log = []; state.topIsLive = true; renderResult(); refreshLive();
    });
    $('btnSave').addEventListener('click', saveCurrent);
    $('btnLink').addEventListener('click', () => {
      location.hash = encodeURIComponent(el.ta.value.trim());
      const url = location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('link copied'), () => toast('link is in the address bar'));
      else toast('link is in the address bar');
    });

    setDrawer(store.read(LS_DRAWER, false) === true);
    el.drawer.addEventListener('click', () =>
      setDrawer(!el.paneTools.classList.contains('collapsed')));

    el.tabs.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (!b) return;
      setDrawer(false);                        // tapping a tab always opens the drawer
      switchTab(b.getAttribute('data-tab'));
    });

    window.addEventListener('hashchange', () => {
      const h = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (h && h !== el.ta.value) { el.ta.value = h; onInput(); }
    });

    onInput();
    el.ta.focus();
    el.ta.setSelectionRange(el.ta.value.length, el.ta.value.length);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
