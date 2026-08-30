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
    reference: $('tab-reference'), saved: $('tab-saved'), vars: $('tab-vars'), toast: $('toast'),
    paneTools: $('paneTools'), drawer: $('drawerToggle'), refSide: $('refSide'),
    preview: $('preview')
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
  const LS_VARS = 're.vars.v1';

  let state = {
    inspect: null,     // last successful DiceEngine.inspect()
    spans: [],         // spans actually painted (overlaps removed)
    error: null,
    log: [],           // [{roll, expanded}] newest first
    activeTab: 'explain',
    statsToken: 0,
    curRow: null,      // Explain row the caret last sat on
    hot: null, hotScope: null   // token currently hovered, and in which expression
  };

  /* ======================================================== reference data */
  /* every size that has a solid of its own, for the gallery */
  const DICE_GALLERY = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 100];

  /* Each entry is [example, description, form].
       Every example is valid on its own. A ~ toggles between the grey
       scaffolding and the coloured part that does the referenced work, so
       '4d6~kh3' greys the dice and colours the modifier.
       form: atom inserts as written; suffix hangs the coloured part off the
       term the caret is in; wrap wraps that term. */
  const REFERENCE = [
    ['Dice', [
      ['~d20', 'one die — a value', 'atom'],
      ['~4d6', 'four dice — a set, summed when a value is needed', 'atom'],
      ['~(2+2)~d6', 'computed quantity', 'atom'],
      ['3d~(2*6)', 'computed number of sides', 'atom']
    ]],
    ['Sets', [
      ['~(~d6,d8~)', 'a set built by listing values', 'atom'],
      ['~4(~d10+d6~)', 'repeat an expression into a set of 4', 'atom'],
      ['~2(~d10,2d6~)', 'sets inside sets unpack', 'atom'],
      ['(d10,~-~2d6)', 'a minus flips every member', 'atom']
    ]],
    ['Keep & drop', [
      ['4d6~kh3', 'keep the highest 3 — needs a set', 'suffix'],
      ['2d20~kl1', 'keep the lowest — disadvantage', 'suffix'],
      ['4d6~dl1', 'drop the lowest', 'suffix'],
      ['4d6~dh1', 'drop the highest', 'suffix'],
      ['(3d6,2d8)~kh3', 'best 3 across a listed set', 'suffix']
    ]],
    ['Exploding', [
      ['d6~e', 'roll again and add when it lands on 6', 'suffix'],
      ['d6~ei', 'keep exploding while it hits 6', 'suffix'],
      ['d6~e5', 'explode on 5 or more', 'suffix'],
      ['d6~ep', 'penetrating: the extra die takes -1', 'suffix'],
      ['d6~epi', 'penetrating, repeated', 'suffix']
    ]],
    ['Re-rolling', [
      ['4d6~r', 're-roll a 1, once', 'suffix'],
      ['4d6~ri', 're-roll 1s until they stop', 'suffix'],
      ['4d6~r2', 're-roll 2 and below, once', 'suffix'],
      ['4d10~u', 'force every die to a different value', 'suffix'],
      ['4d10~u3', 'give up after three attempts', 'suffix']
    ]],
    ['Results', [
      ['3d6~s5', 'mark each 5+ a success — counts as 1', 'suffix'],
      ['3d6~>=5', 'the same, with s left out', 'suffix'],
      ['3d6~f2', 'mark each 2 or less a failure', 'suffix'],
      ['2d20~cs19', 'mark 19+ a critical success', 'suffix'],
      ['2d20~cf2', 'mark 2 or less a critical failure', 'suffix']
    ]],
    ['Clamp', [
      ['4d6~min2', 'treat any face below 2 as 2', 'suffix'],
      ['4d6~max5', 'treat any face above 5 as 5', 'suffix']
    ]],
    ['Maths', [
      ['2d6~+2', 'add', 'suffix'],
      ['2d6~-2', 'subtract', 'suffix'],
      ['2d6~*2', 'multiply — the set is summed first', 'suffix'],
      ['2d6~/2', 'divide', 'suffix'],
      ['2d6~%2', 'remainder', 'suffix'],
      ['2d6~^2', 'raise to a power', 'suffix'],
      ['~max(~d20,10~)', 'the largest value', 'wrap'],
      ['~min(~d20,10~)', 'the smallest value', 'wrap']
    ]],
    ['Words & choices', [
      ['d20>=15~?hit:miss', 'pick between two results', 'suffix'],
      ['~\"a long word\"', 'a quoted word, spaces allowed', 'atom'],
      ['~hit', 'a bare word — a variable if one is set', 'atom'],
      ['~{atk}', 'always the variable, never a word', 'atom']
    ]],
    ['Variables', [
      ['~atk:=d20+5,~2atk', 'set one for this expression only', 'prefix'],
      ['~2atk', 'used twice means rolled twice', 'atom']
    ]],
    ['Custom dice', [
      ['~[1,1,1,1,1,6]', 'six faces, mostly ones', 'atom'],
      ['~[hit,hit,miss]', 'faces can be words', 'atom'],
      ['~[d6,d10]', 'a face can be another roll', 'atom'],
      ['~3[a,b]', 'roll a custom die three times', 'atom']
    ]],
    ['Whole roll', [
      ['~6x~4d6dl1', 'repeat the whole expression 6 times', 'prefix'],
      ['2d6~,3d8', 'separate rolls, reported together', 'append'],
      ['2d20kh1~#attack', 'label, ignored by the maths', 'append']
    ]],
    ['Comparisons', [
      ['d6e~=6', 'exactly', 'suffix'],
      ['d6e~>=5', 'at least', 'suffix'],
      ['4d6r~<=2', 'at most', 'suffix'],
      ['4d6r~!=3', 'anything but', 'suffix']
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
  /* Node ids are only meaningful within one expression, so hovering is scoped.
     Identical expressions share a scope id, which means the editor and a history
     entry of the same roll light each other up, while unrelated rolls stay put. */
  const scopeIds = new Map();
  function scopeFor(expr) {
    const key = String(expr || '').trim();
    if (!scopeIds.has(key)) scopeIds.set(key, 's' + (scopeIds.size + 1));
    return scopeIds.get(key);
  }

  function setHot(id, scope) {
    if (state.hot === id && state.hotScope === scope) return;
    state.hot = id; state.hotScope = scope;
    document.querySelectorAll('.hot').forEach((n) => n.classList.remove('hot'));
    if (!id || !scope) return;
    const within = '[data-scope="' + scope + '"] ';
    const sel = '[data-x="' + id + '"]';
    document.querySelectorAll(
      within + '.t-brk' + sel + ', ' + within + '.t-dice' + sel + ', ' +
      within + '.t-mod' + sel + ', ' + within + '.t-op' + sel + ', ' +
      within + '.exrow' + sel + ', ' + within + '.r-term' + sel + ', ' +
      within + '.r-grp' + sel + ', ' + within + '.r-op' + sel + ', ' +
      within + '.r-brk' + sel + ', ' + within + '.sumbar' + sel + ', ' +
      // a lone die carries the tag itself; only a set of them has a term to wrap it
      within + '.die' + sel + ', ' + within + '.r-kw' + sel
    ).forEach((n) => n.classList.add('hot'));
  }

  const hotFrom = (node) => {
    const t = node && node.closest('[data-x]');
    const s = node && node.closest('[data-scope]');
    if (t && s) setHot(t.getAttribute('data-x'), s.getAttribute('data-scope'));
    else setHot(null, null);
  };

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
      row.addEventListener('mouseenter', () => setHot(id, el.explain.getAttribute('data-scope')));
      row.addEventListener('mouseleave', () => setHot(null, null));
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
  const MARK_WORD = {
    success: ['success', 'successes'], failure: ['failure', 'failures'],
    critSuccess: ['critical', 'criticals'], critFail: ['crit fail', 'crit fails']
  };

  function markList(marks) {
    return Object.keys(marks).map((k) => {
      const w = MARK_WORD[k] || [k, k];
      return marks[k] + ' ' + (marks[k] === 1 ? w[0] : w[1]);
    });
  }

  /* A roll that produces result types reads like a game score — every type the
     expression could produce, best to worst, so a critical that never turned up
     still shows its nought. */
  function scoreHTML(roll) {
    const poss = roll.possible || [];
    if (!poss.length) return null;
    const m = roll.marks || {};
    return '<span class="score">' + poss.map((k) =>
      '<b class="' + k + '">' + (m[k] || 0) + '</b>').join('<i>-</i>') + '</span>';
  }

  /** the headline: a number, a score, or the word it landed on */
  function totalHTML(roll) {
    const score = scoreHTML(roll);
    const plain = roll.numeric ? E.fmt(roll.total) : (roll.text || '—');
    // a list of words needs the room a number never does
    const cls = 'tv' + (plain.length > 8 ? ' long' : '');
    if (!score) return '<span class="' + cls + '">' + esc(plain) + '</span>';
    // the number only earns its place when it says more than the score does
    const hits = (roll.marks && roll.marks.success) || 0;
    if (roll.numeric && roll.total !== hits) {
      return '<span class="tv">' + esc(plain) + '</span><span class="tsc">' + score + '</span>';
    }
    return score;
  }

  const setTotal = (s) => { try { return E.fmt(s.total()); } catch (e) { return '—'; } };

  /** history entries below the newest collapse to a single line */
  function lineHTML(roll, idx) {
    // the label replaces the expression when there is one; showing both is noise
    const name = roll.label
      ? '<span class="ll">' + esc(roll.label) + '</span>'
      : '<span class="lx">' + esc(roll.notation) + '</span>';
    return '<div class="line" data-open="' + idx + '" data-scope="' + scopeFor(roll.input) +
      '" title="show the breakdown">' +
      '<span class="lt">' + totalHTML(roll) + '</span>' + name +
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
        '<div class="setrow"><span class="i">' + esc(s.name || ('#' + (i + 1))) + '</span>' +
          '<span class="body">' + s.html(opts) + '</span>' +
          '<span class="st">' + esc(setTotal(s)) + '</span></div>'
      ).join('');
    } else {
      rows = '<div class="setrow"><span class="body">' + roll.sets[0].html(opts) + '</span></div>';
    }

    let tally = '';
    if (roll.marks) {
      tally = '<div class="tally">' + markList(roll.marks)
        .map((t) => '<b>' + esc(t) + '</b>').join(' &middot; ') +
        (roll.numeric ? ' &rarr; ' + E.fmt(roll.total) : '') + '</div>';
    }

    const meta = [];
    if (many) meta.push(roll.sets.length + ' sets, summed');
    if (live) meta.push('<span class="pulse">live &mdash; Enter to keep</span>');
    else meta.push(roll.time);
    meta.push('<button class="again" data-again="' + idx + '">roll again</button>');

    return '<div class="card' + (live ? ' live' : '') + '" data-card="' + idx +
      '" data-scope="' + scopeFor(roll.input) + '">' +
      '<div class="top">' +
        '<div class="total">' + totalHTML(roll) + '</div>' +
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
      e.expanded ? cardHTML(e.roll, false, i) : lineHTML(e.roll, i)
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

  /** the dice this expression would roll, by name — no randomness involved */
  function renderPreview() {
    if (state.error || !el.ta.value.trim()) { el.preview.innerHTML = ''; return; }
    try { el.preview.innerHTML = '<div class="treehost">' + E.preview(el.ta.value) + '</div>'; }
    catch (e) { el.preview.innerHTML = ''; return; }
    drawTrees(el.preview);
  }

  /** Rolling only ever happens here: on Enter, or the Roll button. */
  function commitRoll() {
    if (state.error) { flashError(); return; }
    const entry = makeRoll();
    if (!entry) { flashError(); return; }
    state.log.unshift(entry);
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

  /* '4d6~kh3' -> grey '4d6', coloured 'kh3'. Odd segments are the coloured
     part; what gets inserted depends on the form. */
  function snippet(code) {
    const seg = code.split('~');
    const html = seg.map((t, i) =>
      t ? '<i class="' + (i % 2 ? 'on' : 'off') + '">' + esc(t) + '</i>' : '').join('');
    const active = seg.filter((t, i) => i % 2).join('');
    const plain = seg.join('');
    // for a wrapper the grey part is the placeholder: floor( 3d6/2 ) -> floor(_)
    const template = seg.map((t, i) => (i % 2 ? t : (t ? '_' : ''))).join('');
    return { html, active, plain, template };
  }

  function renderReference() {
    const html = '<div class="refgrid">' + galleryHTML() + REFERENCE.map(([name, items]) =>
      '<div class="refgroup"><h3>' + esc(name) + '</h3>' + items.map(([code, desc, form]) => {
        const s = snippet(code);
        const tag = form ? ' data-ins="' + esc(code) + '" data-form="' + form + '"' : ' class="inert"';
        return '<div class="refrow"><code' + tag + '>' + s.html + '</code>' +
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
      const parts = snippet(c.getAttribute('data-ins'));
      c.addEventListener('click', () => applySnippet({
        form, plain: parts.plain, active: parts.active, template: parts.template
      }));
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
    }({ args: p.parts.map((x) => x.ast) }));

    const node = best || last;
    // nothing dice-like to hang off: treat the whole expression as the target
    if (!node) return { a: off, b: el.ta.value.length, whole: true };
    return { a: node.sp[0] + off, b: node.sp[1] + off, whole: false };
  }

  /* Clicking the reference must never leave the field unparseable. Each form
     builds candidates in order of preference, every candidate is parsed, and
     the first one that survives wins. An empty field falls back to the whole
     example, since there is nothing there to attach to. */
  const parses = (v) => {
    if (!v.trim()) return false;
    try { E.parse(v); return true; } catch (e) { return false; }
  };

  function applySnippet(item) {
    const t = el.ta, cur = t.value;
    const tries = [];

    if (!cur.trim()) {
      tries.push([item.plain, item.plain.length]);          // nothing to build on
    } else if (item.form === 'atom') {
      const a = t.selectionStart, b = t.selectionEnd;
      tries.push([cur.slice(0, a) + item.plain + cur.slice(b), a + item.plain.length]);
    } else if (item.form === 'prefix') {
      tries.push([item.active + cur, item.active.length]);
    } else if (item.form === 'append') {
      tries.push([cur + item.active, cur.length + item.active.length]);
    } else {
      const sp = targetSpan();
      if (sp) {
        const inner = cur.slice(sp.a, sp.b);
        if (item.form === 'suffix') {
          // a modifier binds to a die or a bracket, so bracket anything else
          tries.push([cur.slice(0, sp.a) + inner + item.active + cur.slice(sp.b),
                      sp.a + inner.length + item.active.length]);
          tries.push([cur.slice(0, sp.a) + '(' + inner + ')' + item.active + cur.slice(sp.b),
                      sp.a + inner.length + item.active.length + 2]);
        } else {
          const wrapped = item.template.replace('_', inner);
          tries.push([cur.slice(0, sp.a) + wrapped + cur.slice(sp.b), sp.a + wrapped.length]);
        }
      }
    }
    // last resort: the example on its own, as a separate roll after a comma
    if (cur.trim()) tries.push([cur + ', ' + item.plain, cur.length + 2 + item.plain.length]);

    for (const [candidate, caret] of tries) {
      if (!parses(candidate)) continue;
      t.value = candidate;
      t.focus();
      t.setSelectionRange(caret, caret);
      return onInput();
    }
    toast('that snippet does not fit here');
  }

  /* ------------------------------------------------------------ sum tree
     Every summing node carries data-sum. Measure where each one sits over the
     dice and draw it as a bracket underneath, innermost nearest the dice. */
  const SUM_ROW = 17;
  const SEL_TREE = '[data-sum], [data-steps], [data-note]';

  /* What each node draws, innermost first: one bar per modifier step, then one
     for its own value. A node's value is skipped when it fills the whole row —
     the headline already says it, and repeating it buys nothing. */
  function barsFor(n, body) {
    const out = (n.getAttribute('data-steps') || '').split('|').filter(Boolean)
      .map((label) => ({ label, sum: null, name: false }));
    const sum = n.getAttribute('data-sum');
    const note = (n.getAttribute('data-note') || '').split('|').filter(Boolean).join(', ');
    const sole = n.parentElement === body && body.children.length === 1;
    if (sum !== null && !sole) out.push({ label: note, sum, name: true });
    else if (note && sum === null) out.push({ label: note, sum: null, name: true });
    return out;
  }

  function drawTrees(root) {
    root.querySelectorAll('.setrow .body, .treehost').forEach((body) => {
      body.querySelectorAll('.sumtree').forEach((n) => n.remove());
      const nodes = Array.prototype.slice.call(body.querySelectorAll(SEL_TREE));
      if (!nodes.length) return;
      const base = body.getBoundingClientRect();
      const items = nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          node: n, bars: barsFor(n, body), row: 0,
          left: r.left - base.left, width: r.width,
          x: n.getAttribute('data-x'), drop: n.hasAttribute('data-drop'),
          mark: n.getAttribute('data-mark')
        };
      }).filter((it) => it.bars.length);
      if (!items.length) return;

      // an enclosing node starts above everything it encloses
      for (const inner of items) {
        for (const outer of items) {
          if (outer !== inner && outer.node.contains(inner.node)) {
            outer.row = Math.max(outer.row, inner.row + inner.bars.length);
          }
        }
      }
      const rows = items.reduce((a, it) => Math.max(a, it.row + it.bars.length), 0);

      const layer = document.createElement('div');
      layer.className = 'sumtree';
      layer.style.height = (rows * SUM_ROW) + 'px';
      const drawn = [];
      for (const it of items) {
        it.bars.forEach((b, k) => {
          const bar = document.createElement('div');
          bar.className = 'sumbar' + (it.drop ? ' dropped' : '') +
            (it.mark && b.name ? ' ' + it.mark : '') + (b.name ? '' : ' step');
          if (it.x) bar.setAttribute('data-x', it.x);
          bar.style.left = it.left + 'px';
          bar.style.width = Math.max(it.width, 20) + 'px';
          bar.style.top = ((it.row + k) * SUM_ROW) + 'px';   // innermost nearest the dice
          // the label leads, so you know what the number is before you read it
          bar.innerHTML = '<span class="sumval">' + (b.label ? '<i></i>' : '') +
            (b.sum === null ? '' : '<b>' + esc(b.sum) + '</b>') + '</span>';
          layer.appendChild(bar);
          drawn.push([bar, b]);
        });
      }
      body.appendChild(layer);

      for (const [bar, b] of drawn) {
        if (b.label) fitLabel(bar, b.label, b.name);
      }
    });
  }

  /* Trim the label from the end, so what survives is the front of the phrase —
     where the verb and the count are. A name that stands over a value never
     disappears entirely: it gives up letters instead, down to a stub. */
  const NAME_STUB = 3;
  const NAME_ROOM = 76;      // a short name is worth spilling past its bracket for
  function fitLabel(bar, label, named) {
    const val = bar.querySelector('.sumval');
    const tag = val.querySelector('i');
    const room = () =>
      Math.max(bar.getBoundingClientRect().width, named ? NAME_ROOM : 0);
    const fits = () => val.getBoundingClientRect().width <= room();

    const words = label.split(' ');
    for (let k = words.length; k > 0; k--) {
      tag.textContent = words.slice(0, k).join(' ');
      if (fits()) return;
    }
    if (!named) { tag.remove(); return; }
    const first = words[0];
    for (let n = first.length - 1; n > NAME_STUB; n--) {
      tag.textContent = first.slice(0, n) + '…';
      if (fits()) return;
    }
    tag.textContent = first.slice(0, NAME_STUB) + (first.length > NAME_STUB ? '…' : '');
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

  /* ============================================================ variables
     A variable is just an expression stored under a name. It is worked out
     afresh at every occurrence, so `2atk` rolls twice. */
  function loadVars() {
    const v = store.read(LS_VARS, null);
    return Array.isArray(v) ? v : [{ name: 'atk', expr: 'd20+5' }];
  }

  function pushVars(list) {
    const map = {};
    for (const v of list) if (v.name) map[v.name] = v.expr;
    E.setVars(map);
    store.write(LS_VARS, list);
  }

  const isInt = (s) => /^\s*-?\d+\s*$/.test(String(s == null ? '' : s));

  /* Only the two inputs take Tab, so tabbing out of a name always lands on its
     own expression rather than a button in between. */
  function renderVars() {
    const list = loadVars();
    el.vars.innerHTML =
      '<div class="varhint">A variable holds an expression and is worked out again at every ' +
      'occurrence. Use the bare name, or <code>{name}</code> when a plain word would be ambiguous. ' +
      'Inside an expression, <code>atk:=d20+5</code> as its own item sets one for that roll alone.</div>' +
      list.map((v, i) =>
        '<div class="varitem" data-i="' + i + '">' +
          '<div class="varrow">' +
            '<button class="del" title="remove" tabindex="-1">&times;</button>' +
            '<input class="vname" value="' + esc(v.name) + '" spellcheck="false" placeholder="name">' +
            '<input class="vexpr" value="' + esc(v.expr) + '" spellcheck="false" placeholder="expression">' +
            '<span class="step' + (isInt(v.expr) ? '' : ' off') + '">' +
              '<button class="vdec" title="subtract 1" tabindex="-1">&minus;</button>' +
              '<button class="vinc" title="add 1" tabindex="-1">+</button>' +
            '</span>' +
          '</div>' +
          '<div class="varerr' + (varError(v.expr) ? ' on' : '') + '">' +
            esc(varError(v.expr) || '') + '</div>' +
        '</div>').join('') +
      '<button class="varadd">+ add a variable</button>';

    el.vars.querySelectorAll('.varitem input').forEach((inp) => {
      inp.addEventListener('input', () => commitVars(false));
      inp.addEventListener('change', () => commitVars(true));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
    });
  }

  function readVars() {
    const out = [];
    el.vars.querySelectorAll('.varitem').forEach((row) => {
      out.push({
        name: row.querySelector('.vname').value.replace(/[^a-zA-Z_]/g, ''),
        expr: row.querySelector('.vexpr').value
      });
    });
    return out.length ? out : loadVars();
  }

  /* Saving must not rebuild the rows: re-rendering mid-edit was what stole the
     focus when tabbing out of a name. Only the error line and the stepper move. */
  function commitVars(tidy) {
    const list = readVars();
    pushVars(list);
    el.vars.querySelectorAll('.varitem').forEach((row, i) => {
      const v = list[i] || { name: '', expr: '' };
      const err = varError(v.expr);
      const box = row.querySelector('.varerr');
      box.textContent = err || '';
      box.classList.toggle('on', !!err);
      row.querySelector('.step').classList.toggle('off', !isInt(v.expr));
      const nm = row.querySelector('.vname');
      if (tidy && nm.value !== v.name) nm.value = v.name;
    });
    onInput();                 // the expression may now mean something different
  }

  /** one delegated listener, so re-rendering the rows never loses the wiring */
  function wireVars() {
    el.vars.addEventListener('click', (ev) => {
      if (ev.target.closest('.varadd')) {
        const list = readVars();
        list.push({ name: '', expr: '' });
        pushVars(list);
        renderVars();
        const box = el.vars.querySelector('.varitem:last-of-type .vname');
        if (box) box.focus();
        return;
      }
      const item = ev.target.closest('.varitem');
      if (!item) return;
      if (ev.target.closest('.del')) {
        const list = readVars();
        list.splice(+item.getAttribute('data-i'), 1);
        pushVars(list);
        renderVars();
        onInput();
        return;
      }
      const inc = ev.target.closest('.vinc'), dec = ev.target.closest('.vdec');
      if (!inc && !dec) return;
      const box = item.querySelector('.vexpr');
      if (!isInt(box.value)) return;
      box.value = String(parseInt(box.value.trim(), 10) + (inc ? 1 : -1));
      commitVars(true);
    });
  }

  function varError(expr) {
    if (!String(expr || '').trim()) return null;
    try { E.parse(expr); return null; } catch (e) { return e.message; }
  }

  /* ================================================================= tabs */
  function switchTab(name) {
    state.activeTab = name;
    el.tabs.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', b.getAttribute('data-tab') === name));
    ['explain', 'details', 'reference', 'vars', 'saved'].forEach((n) =>
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
      paint(); renderExplain(); renderPreview();
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

    const sc = scopeFor(raw);
    el.wrap.setAttribute('data-scope', sc);
    el.preview.setAttribute('data-scope', sc);
    el.explain.setAttribute('data-scope', sc);

    paint();
    renderExplain();
    syncCaret(true);

    renderPreview();
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
    pushVars(loadVars());
    renderVars();
    wireVars();

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

    el.wrap.addEventListener('mousemove', (ev) =>
      setHot(spanAtPoint(ev.clientX, ev.clientY), el.wrap.getAttribute('data-scope')));
    el.wrap.addEventListener('mouseleave', () => setHot(null, null));
    el.result.addEventListener('mouseover', (ev) => hotFrom(ev.target));
    el.result.addEventListener('mouseleave', () => setHot(null, null));
    el.preview.addEventListener('mouseover', (ev) => hotFrom(ev.target));
    el.preview.addEventListener('mouseleave', () => setHot(null, null));

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
        if (state.log[i]) { state.log[i].expanded = false; renderResult(); }
      }
    });
    $('btnClear').addEventListener('click', () => {
      state.log = []; renderResult();
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
