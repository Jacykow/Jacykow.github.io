/* ============================================================================
   Random Engine — UI layer
   ----------------------------------------------------------------------------
   A live syntax-highlighted expression field over a result stack, with a
   drawer of tools that stays in step with the caret. The engine does the
   thinking; nothing here parses or rolls anything.

   Two ideas run through the whole file:

     Every rolled thing is tagged `data-x`, and every place one can be drawn
     carries a `data-scope`. That is what lets the editor, the Explain list,
     the preview and a result light each other up on hover.

     A saved roll and a variable are the same shape — an expression named by
     the `# name` at its end — so one pair of functions draws and wires both
     lists, and the shortcut bar is a third view of the same two.
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
    preview: $('preview'), shortcuts: $('shortcuts')
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
    activeTab: window.matchMedia('(min-width: 1000px)').matches ? 'explain' : 'reference',
    statsToken: 0,
    curRow: null,      // Explain row the caret last sat on
    hot: null, hotScope: null   // token currently hovered, and in which expression
  };

  /* --------------------------------------- reference data, in its own file */
  const DICE_GALLERY = window.RandomEngineDice || [];
  const REFERENCE = window.RandomEngineReference || [];

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

  /* ================================================================== url
     The address bar carries the whole state: the expression being edited, the
     variables and the saved rolls. A bare hash is just an expression, so a
     hand-written or older link still opens; anything more rides in a tagged
     base64 payload. The fragment never reaches the server, so the only real
     ceiling is what a browser will hold, which a saved list of 60 comes
     nowhere near. */
  /* There are two kinds of link, because they are for two different things.

     The address bar holds only the expression, plainly readable and updated
     when you roll, so a link copied from the browser is a roll you can send
     someone. A setup link is asked for, and carries the saved rolls and the
     variables: opening one adopts it whole, while pasting one into the Setup
     tab lists what it holds and waits to be told.

     Neither reaches the server — a fragment never leaves the browser. */
  const SETUP_TAG = 'setup=';
  const LS_UNDO = 're.setup.prev';

  const b64 = {
    enc(s) {
      let bin = '';
      for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    dec(s) {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
  };

  const here = () => location.origin === 'null'
    ? location.href.split('#')[0] : location.origin + location.pathname;

  /* Safari rate-limits replaceState to about a hundred calls per half minute,
     so this is only ever called on a roll, never on a keystroke. */
  function syncURL() {
    const e = el.ta.value.trim();
    try {
      history.replaceState(null, '', e ? '#' + encodeURIComponent(e) : location.pathname);
    } catch (err) { /* file:// refuses replaceState */ }
  }

  function setupLink() {
    return here() + '#' + SETUP_TAG + b64.enc(JSON.stringify({
      v: loadVars().filter((v) => nameOf(v.expr)).map((v) => [v.expr, v.mark ? 1 : 0]),
      s: loadSaved().filter((x) => titleOf(x.expr)).map((x) => [x.expr, x.mark ? 1 : 0])
    }));
  }

  /** read a setup out of a link, a bare payload, or the address bar */
  function readSetup(text) {
    const raw = String(text == null ? location.hash : text).trim();
    const at = raw.indexOf(SETUP_TAG);
    if (at < 0) return null;
    try {
      const d = JSON.parse(b64.dec(raw.slice(at + SETUP_TAG.length).replace(/[#?].*$/, '')));
      const pairs = (a) => (Array.isArray(a) ? a.filter(Array.isArray) : [])
        .map((row) => normalise(row.length > 2
          ? { name: String(row[0]), expr: String(row[1]), mark: !!row[2] }
          : { expr: String(row[0]), mark: !!row[1] }))
        .filter((x) => titleOf(x.expr));
      return { vars: pairs(d.v), saved: pairs(d.s) };
    } catch (e) { return null; }
  }

  /** what the address bar says to put in the field, if anything */
  function readExpr() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw || raw.indexOf(SETUP_TAG) === 0) return null;
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  /* A setup is adopted whole rather than merged: it is a setup, not an
     addition. The one it replaced is kept so it can be had back. */
  /* An import adds to what you already have rather than taking its place, and
     nothing is added without being picked out first. What one added is written
     down, so undoing it is the same act with the ticks the other way round. */
  function addSetup(pick) {
    const vars = loadVars(), saved = loadSaved();
    const added = { v: [], s: [] };
    for (const v of pick.vars) {
      const at = vars.findIndex((x) => nameOf(x.expr) === nameOf(v.expr));
      if (at >= 0 && vars[at].expr === v.expr) continue;      // already exactly this
      if (at >= 0) vars[at] = v; else vars.push(v);
      added.v.push(v.expr);
    }
    for (const x of pick.saved) {
      const at = saved.findIndex((y) => titleOf(y.expr) === titleOf(x.expr));
      if (at >= 0 && saved[at].expr === x.expr) continue;
      if (at >= 0) saved[at] = x; else saved.push(x);
      added.s.push(x.expr);
    }
    pushVars(vars);
    store.write(LS_SAVED, saved);
    store.write(LS_UNDO, added);
    renderVars(); renderSaved(); renderShortcuts();
    return added.v.length + added.s.length;
  }

  function replaceSetup(st) {
    store.write(LS_UNDO, { was: { v: loadVars(), s: loadSaved() } });
    pushVars(st.vars.slice());
    store.write(LS_SAVED, st.saved.slice());
    renderVars(); renderSaved(); renderShortcuts();
    return st.vars.length + st.saved.length;
  }

  function dropSetup(pick) {
    const gone = new Set(pick.vars.concat(pick.saved).map((x) => x.expr));
    pushVars(loadVars().filter((v) => !gone.has(v.expr)));
    store.write(LS_SAVED, loadSaved().filter((x) => !gone.has(x.expr)));
    store.write(LS_UNDO, null);
    renderVars(); renderSaved(); renderShortcuts();
    return gone.size;
  }

  /** what the last import brought in, as a setup shape */
  function lastImport() {
    const a = store.read(LS_UNDO, null);
    if (!a) return null;
    if (a.was) return { whole: a.was };
    if (!(a.v || []).length && !(a.s || []).length) return null;
    return {
      vars: (a.v || []).map((expr) => ({ expr, mark: false })),
      saved: (a.s || []).map((expr) => ({ expr, mark: false }))
    };
  }

  /* ================================================================ names
     A saved roll and a variable are both just an expression; the `# name` at
     its end is what they are called. Keeping the name inside the text is what
     lets one field hold the whole thing, and the engine already strips it
     before parsing, so a variable's name is drawn once — on its subtotal
     bracket — and never twice. */
  /* What a thing is called and what it is called *by* are two questions. The
     label answers the first; a `{name}` inside it answers the second when they
     differ, so "Modyfikatory {mod}" shows as Modyfikatory and is written as mod.
     When the label is already a plain word it serves as both. */
  const REF_RE = /\{([a-zA-Z_]+)\}/;
  const labelOf = (expr) => E.splitLabel(expr).label || '';
  const bodyOf = (expr) => E.splitLabel(expr).body.trim();

  function nameOf(expr) {
    const l = labelOf(expr);
    const m = REF_RE.exec(l);
    if (m) return m[1];
    return /^[a-zA-Z_]+$/.test(l.trim()) ? l.trim() : null;
  }
  const titleOf = (expr) =>
    labelOf(expr).replace(REF_RE, '').replace(/\s+/g, ' ').trim() || nameOf(expr) || '';

  /* `<d6>` in a name draws the die instead of spelling it out, so a bar of
     shortcuts reads at a glance. */
  const dieChip = (n) => {
    const shape = E.shapeFor(n);
    const face = 'D' + n;
    const size = face.length >= 4 ? ' v4' : (face.length === 3 ? ' v3' : ' v2');
    return '<span class="die inline ghost s-' + shape + '">' +
      '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<use href="#sh-' + shape + '"/></svg>' +
      '<span class="dieval' + size + '">' + face + '</span></span>';
  };
  /** one place turns `<dN>` into a die, wherever a name or a label is shown */
  const dieText = (s) =>
    esc(s == null ? '' : s).replace(/&lt;d(\d+)&gt;/gi, (m, n) => dieChip(+n));
  const titleHTML = (expr) => dieText(titleOf(expr));

  /** swap the expression, keep the name */
  function withBody(expr, body) {
    const name = nameOf(expr);
    return name ? body + ' # ' + name : body;
  }

  /** an older entry kept its name beside the expression; the label holds it now */
  const normalise = (x) => {
    const expr = String((x && x.expr) || '');
    const named = (x && x.name && !E.splitLabel(expr).label) ? expr + ' # ' + x.name : expr;
    return { expr: named, mark: !!(x && x.mark) };
  };
  /* A first visit gets the three rolls almost everyone starts from, rather than
     an empty bar that says nothing about what the bar is for. */
  const PRESETS = (window.RandomEnginePresets || []).map((x) => ({
    name: x.name,
    note: x.note,
    vars: (x.vars || []).map((expr) => ({ expr, mark: true })),
    saved: (x.saved || []).map((expr) => ({ expr, mark: true }))
  }));
  const FIRST_ROLLS = PRESETS.length ? PRESETS[0].saved.map((x) => ({ expr: x.expr, mark: true })) : [];
  const loadSaved = () => {
    const v = store.read(LS_SAVED, null);
    return Array.isArray(v) ? v.map(normalise) : FIRST_ROLLS.slice();
  };

  /* ------------------------------------------------------------- editing
     Everything that writes into the field types it the way a person would, so
     the browser keeps its own undo history and Ctrl+Z does what it should. */
  function typeInto(text, replaceAll) {
    el.ta.focus();
    if (replaceAll) el.ta.select();
    let done = false;
    try { done = document.execCommand('insertText', false, text); } catch (e) { done = false; }
    if (!done) {
      const a = el.ta.selectionStart, b = el.ta.selectionEnd;
      el.ta.value = el.ta.value.slice(0, a) + text + el.ta.value.slice(b);
      el.ta.setSelectionRange(a + text.length, a + text.length);
    }
    onInput();
  }

  /** the same undo the keyboard reaches, for a screen that has no keyboard */
  function editUndo(which) {
    el.ta.focus();
    try { document.execCommand(which); } catch (e) { /* unsupported */ }
    onInput();
  }

  function copy(text, ok, fallback) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast(ok), () => toast(fallback));
    } else toast(fallback);
  }

  /* ============================================================ shortcuts
     A bookmarked saved roll or variable gets a chip under the expression, so a
     session's handful of things is one click away without opening a drawer.
     A roll chip loads the expression; a variable chip edits the value in place
     and never the name, since the name is what expressions refer to. */
  const STEP_BIG = 10;
  const isInt = (s) => /^\s*-?\d+\s*$/.test(String(s == null ? '' : s));

  /* The chip and the list row both nudge a whole number, and both size a field
     to what it holds, so they say it once here. */
  const FIELD = { min: 2, max: 14 };
  const sizeOf = (v) => Math.max(FIELD.min, Math.min(FIELD.max, String(v).length));
  const sizeVal = (box) => box.setAttribute('size', String(sizeOf(box.value)));

  /* One button, so a chip can put them either side of its field and a list row
     can keep them together at the end. */
  const stepBtn = (cls) => {
    const sign = cls === 'vinc' ? '+' : '&minus;';
    return '<button class="' + cls + '" tabindex="-1" title="' + sign + '1, or ' + sign +
      STEP_BIG + ' with shift or the right button">' + sign + '</button>';
  };

  /** which way and how far a click on a stepper means to move, or null */
  function stepDelta(ev) {
    const b = ev.target.closest('.vinc, .vdec');
    if (!b) return null;
    ev.preventDefault();
    const big = ev.shiftKey || ev.type === 'contextmenu';
    return { b, by: (b.classList.contains('vinc') ? 1 : -1) * (big ? STEP_BIG : 1) };
  }

  function renderShortcuts() {
    // the bar redraws while its own field is being typed in, so hold the caret
    const act = document.activeElement;
    const keep = act && act.classList && act.classList.contains('vval') &&
      el.shortcuts.contains(act)
      ? { name: act.closest('[data-var]').getAttribute('data-var'),
          a: act.selectionStart, b: act.selectionEnd }
      : null;

    const rolls = loadSaved().filter((x) => x.mark && titleOf(x.expr));
    const vars = loadVars().filter((v) => v.mark && nameOf(v.expr));
    if (!rolls.length && !vars.length) { el.shortcuts.innerHTML = ''; return; }

    el.shortcuts.innerHTML =
      rolls.map((r, i) =>
        '<button class="sc roll" data-roll="' + i + '" title="' + esc(r.expr) + '">' +
          titleHTML(r.expr) + '</button>').join('') +
      vars.map((v) => {
        const body = bodyOf(v.expr);
        return '<span class="sc var' + (isInt(body) ? '' : ' plain') +
          '" data-var="' + esc(nameOf(v.expr)) + '">' +
          '<i>' + titleHTML(v.expr) + '</i>' + stepBtn('vdec') +
          '<input class="vval" value="' + esc(body) + '" spellcheck="false" ' +
                 'size="' + sizeOf(body) + '">' + stepBtn('vinc') +
        '</span>';
      }).join('');

    el.shortcuts.querySelectorAll('.vval').forEach((inp) => {
      inp.addEventListener('input', () => writeVar(inp, inp.value));
      inp.addEventListener('change', () => writeVar(inp, inp.value));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
    });

    if (keep) {
      const box = el.shortcuts.querySelector('[data-var="' + keep.name + '"] .vval');
      if (box) {
        box.focus();
        try { box.setSelectionRange(keep.a, keep.b); } catch (e) { /* not selectable */ }
      }
    }
  }

  /* The chip and the panel are two views of one list. Writing from the chip
     never rebuilds the chip: its buttons have to stay put under the cursor
     while it is being clicked, even as the number grows a digit. The chip
     edits the expression and leaves the name alone. */
  function writeVar(node, val) {
    const chip = node.closest('[data-var]');
    const name = chip.getAttribute('data-var');
    pushVars(loadVars().map((v) =>
      nameOf(v.expr) === name ? { expr: withBody(v.expr, val), mark: v.mark } : v));
    sizeVal(node);
    chip.classList.toggle('plain', !isInt(val));
    renderVars();
    onInput();
  }

  function stepVar(node, by) {
    const box = node.closest('[data-var]').querySelector('.vval');
    if (!isInt(box.value)) return;
    box.value = String(parseInt(box.value.trim(), 10) + by);
    writeVar(box, box.value);
  }

  function wireShortcuts() {
    el.shortcuts.addEventListener('click', (ev) => {
      const s = stepDelta(ev);
      if (s) return stepVar(s.b, s.by);
      const r = ev.target.closest('[data-roll]');
      if (!r) return;
      const item = loadSaved().filter((x) => x.mark && titleOf(x.expr))[+r.getAttribute('data-roll')];
      if (!item) return;
      typeInto(item.expr, true);
      commitRoll();              // a bookmark is a roll, not a thing to load
    });
    // the right button is the quick way to move by ten without a keyboard
    el.shortcuts.addEventListener('contextmenu', (ev) => {
      const s = stepDelta(ev);
      if (s) stepVar(s.b, s.by);
    });
  }

  /* Where the line wraps, the field has to grow to hold it — and the <pre>
     under it follows, since the two only line up while they are the same size. */
  function growEditor() {
    if (!wide.matches) { el.ta.style.removeProperty('height'); return; }
    el.ta.style.height = 'auto';
    el.ta.style.height = el.ta.scrollHeight + 'px';
  }

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
      ? '<span class="ll">' + dieText(roll.label) + '</span>'
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
          ((roll.defs || []).length
            ? '<div class="defs">' + roll.defs.map(esc).join('<span>&middot;</span>') + '</div>'
            : '') +
          (roll.label ? '<div class="lbl"># ' + dieText(roll.label) + '</div>' : '') +
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
    syncURL();                 // the link in the bar is the roll you just made
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
      el.details.innerHTML =
        s.groups.map((g) => section(g.src + (g.times > 1 ? ' ×' + g.times : ''), g)).join('') +
        // the sum is only news when the whole thing comes to a number
        (s.showWhole ? section(s.groups.length ? 'total' : null, s) : '') +
        '<div class="tailroom"></div>';
    }, 0);
  }

  /* A simulation only shows what turned up, so every chart here says what could
     have: each word the expression can produce gets a bar even at nought, and a
     numeric run is bracketed by the smallest and largest it could ever reach —
     worked out from the expression rather than watched for. */
  const section = (title, s) => {
    const body = statsHTML(s);
    if (!body) return '';
    return (title ? '<h4 class="stathead">' + esc(title) + '</h4>' : '') + body;
  };

  function statsHTML(s) {
    if (!s.words.length && !s.numeric) return '';
    const parts = [];

    if (s.words.length) {
      const total = s.n;
      const peak = Math.max.apply(null, s.words.map((w) => s.tally[w] || 0)) || 1;
      parts.push('<div class="wordhist">' + s.words.map((w) => {
        const c = s.tally[w] || 0;
        const pct = (c / total) * 100;
        return '<div class="wrow" title="' + esc(w) + ': ' + pct.toFixed(2) + '%">' +
          '<span class="wname">' + esc(w) + '</span>' +
          '<span class="wbar"><i style="width:' + ((c / peak) * 100).toFixed(2) + '%"></i></span>' +
          '<span class="wpct">' + pct.toFixed(1) + '%</span></div>';
      }).join('') + '</div>');
      if (!s.numeric) {
        parts.push('<div class="histaxis"><span>' + s.n.toLocaleString() + ' rolls</span>' +
          '<span>every result the expression can give</span></div>');
        return parts.join('');
      }
      parts.push('<div class="histaxis"><span>&nbsp;</span>' +
        '<span>and ' + s.numeric.toLocaleString() + ' of ' + s.n.toLocaleString() +
        ' came to a number</span></div>');
    }

    const bounded = s.canMin !== null && s.canMax !== null;
    const cells = [
      ['min', E.fmt(s.min)], ['mean', s.mean.toFixed(2)], ['median', E.fmt(s.median)],
      ['max', E.fmt(s.max)], ['std dev', s.stdev.toFixed(2)],
      ['10th %', E.fmt(s.p10)], ['90th %', E.fmt(s.p90)],
      ['samples', s.numeric.toLocaleString()]
    ];
    if (bounded) {
      cells.push(['can be', E.fmt(s.canMin) + ' … ' + E.fmt(s.canMax)]);
    }
    parts.push('<div class="statgrid">' + cells.map(([k, v]) =>
      '<div class="stat' + (k === 'can be' ? ' wide' : '') + '"><b>' + esc(v) +
      '</b><i>' + esc(k) + '</i></div>').join('') + '</div>');

    // the chart spans everything possible, not just everything seen
    const lo = bounded ? Math.min(s.canMin, s.min) : s.min;
    const hi = bounded ? Math.max(s.canMax, s.max) : s.max;
    const span = hi - lo;
    const bins = Math.max(1, Math.min(60, Math.round(span) + 1));
    const w = span === 0 ? 1 : span / bins;
    const counts = new Array(bins).fill(0);
    for (const t of s.totals) {
      let b = span === 0 ? 0 : Math.floor((t - lo) / w);
      if (b >= bins) b = bins - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    const peak = Math.max.apply(null, counts) || 1;
    const bars = counts.map((c, i) => {
      const a = lo + i * w, b = a + w;
      const pct = ((c / s.numeric) * 100).toFixed(1);
      return '<div class="bar' + (c ? '' : ' empty') + '" style="height:' +
        Math.max(1, (c / peak) * 100) + '%" title="' +
        E.fmt(Math.round(a * 100) / 100) + (w > 1 ? '–' + E.fmt(Math.round(b * 100) / 100) : '') +
        ': ' + pct + '%"></div>';
    }).join('');

    parts.push('<div class="hist">' + bars + '</div>' +
      '<div class="histaxis"><span>' + E.fmt(lo) + '</span>' +
      '<span>' + (bounded ? 'everything it can come to' : 'distribution of the total') +
      '</span><span>' + E.fmt(hi) + '</span></div>');
    return parts.join('');
  }

  /* ============================================================ reference */
  /** the dice gallery: every size that has a solid of its own, drawn */
  function galleryHTML() {
    const dice = DICE_GALLERY.map((n) => {
      const shape = E.shapeFor(n);
      const face = 'D' + n;
      const size = face.length >= 4 ? ' v4' : (face.length === 3 ? ' v3' : ' v2');
      return '<div class="refdie" data-ins="d' + n + '" title="click to insert d' + n + '">' +
        '<span class="die ghost s-' + shape + '">' +
          '<svg class="dieshape" viewBox="0 0 64 64" aria-hidden="true"><use href="#sh-' + shape + '"/></svg>' +
          '<span class="dieval' + size + '">' + face + '</span>' +
        '</span></div>';
    }).join('');
    return '<div class="refgroup"><h3>The dice</h3><div class="refdice">' + dice + '</div></div>';
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

  /* The reference is a reminder, not a manual: one line each, with whatever
     else is worth knowing on hover. The README is where the rules are set out
     in full, for anyone — or anything — that wants to read them all. */
  const HINT = {
    atom: 'click to insert at the caret',
    suffix: 'click to attach to the term the caret is in',
    wrap: 'click to wrap the term the caret is in',
    prefix: 'click to add to the front of the expression',
    append: 'click to add to the end of the expression'
  };

  function renderReference() {
    const html = '<div class="refgrid">' + galleryHTML() + REFERENCE.map(([name, items]) =>
      '<div class="refgroup"><h3>' + esc(name) + '</h3>' + items.map(([code, desc, form, note]) => {
        const s = snippet(code);
        const tip = (note ? note + '\n\n' : '') + (form ? HINT[form] || HINT.atom : '');
        const tag = form
          ? ' data-ins="' + esc(code) + '" data-form="' + form + '"'
          : ' class="inert"';
        return '<div class="refrow" title="' + esc(tip) + '"><code' + tag + '>' + s.html +
          '</code><span>' + esc(desc) + '</span></div>';
      }).join('') + '</div>').join('') +
      '<div class="refgroup"><a class="refdoc" href="README.md" target="_blank" ' +
        'rel="noopener">Full rules in the README &rarr;</a>' +
        '<div class="refrow"><span>Every rule set out at length: the type model, ' +
        'what each modifier needs, and how to build a whole setup.</span></div></div></div>';

    // wide screens get the permanent left rail, narrow ones the drawer tab
    const host = wide.matches ? el.refSide : el.reference;
    const other = wide.matches ? el.reference : el.refSide;
    other.innerHTML = '';
    host.innerHTML = html;

    host.querySelectorAll('[data-ins]').forEach((c) => {
      const form = c.getAttribute('data-form') || 'atom';
      const parts = snippet(c.getAttribute('data-ins'));
      c.addEventListener('click', () => applySnippet({
        form, plain: parts.plain, active: parts.active, template: parts.template
      }));
    });
  }

  /* ------------------------------------------------- placement-aware insert
     Reference snippets say where they attach: `kh3` hangs off a term,
     `max(_)` wraps one. Find the innermost thing a modifier could attach to
     that the caret sits in, and act on that, so clicking builds on what is
     already typed. */
  const ATTACHABLE = { dice: 1, paren: 1, set: 1, rep: 1, custom: 1, word: 1 };
  const KIDS = ['l', 'r', 'v', 'qty', 'sides', 'cond', 'yes', 'no', 'count'];

  function targetSpan() {
    if (!state.inspect) return null;
    const p = state.inspect.parsed, off = p.offset;
    const pos = Math.max(0, Math.min(el.ta.selectionStart, el.ta.value.length) - off);
    let best = null, last = null;

    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.sp && ATTACHABLE[n.t]) {
        if (!last || n.sp[1] > last.sp[1]) last = n;
        if (pos >= n.sp[0] && pos <= n.sp[1] &&
            (!best || (n.sp[1] - n.sp[0]) < (best.sp[1] - best.sp[0]))) best = n;
      }
      for (const k of KIDS) walk(n[k]);
      if (n.args) n.args.forEach(walk);
      if (n.items) n.items.forEach(walk);
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
      typeInto(candidate, true);
      t.setSelectionRange(caret, caret);
      return;
    }
    toast('that snippet does not fit here');
  }

  /* ------------------------------------------------------------ sum tree
     Every summing node carries data-sum. Measure where each one sits over the
     dice and draw it as a bracket underneath, innermost nearest the dice. */
  const SUM_ROW = 17;
  const TREE_TOP = 4;        // clearance between a line and the first bracket
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

  /* The tree is drawn as an overlay rather than a strip underneath, so it
     survives content that wraps: a node that runs onto two lines has two
     rectangles, and each gets its own bracket beneath its own line. Room for
     them comes from the line-height, which is set to fit the deepest stack. */
  function drawTrees(root) {
    root.querySelectorAll('.setrow .body, .treehost').forEach((body) => {
      body.querySelectorAll('.sumtree').forEach((n) => n.remove());
      body.style.removeProperty('line-height');
      const nodes = Array.prototype.slice.call(body.querySelectorAll(SEL_TREE));
      if (!nodes.length) return;

      const items = nodes.map((n) => ({
        node: n, bars: barsFor(n, body), row: 0,
        x: n.getAttribute('data-x'), drop: n.hasAttribute('data-drop'),
        lone: n.hasAttribute('data-lone'), mark: n.getAttribute('data-mark')
      })).filter((it) => it.bars.length);
      if (!items.length) return;

      /* An enclosing node starts above everything it encloses. Deepest first,
         so a node has its own final row before it pushes its enclosers up —
         document order would settle an outer bracket against an inner one that
         had not finished rising, and the two would collide. */
      for (const inner of items.slice().reverse()) {
        for (const outer of items) {
          if (outer !== inner && outer.node.contains(inner.node)) {
            outer.row = Math.max(outer.row, inner.row + inner.bars.length);
          }
        }
      }
      const rows = items.reduce((a, it) => Math.max(a, it.row + it.bars.length), 0);

      // every line needs room under it for the deepest stack that can sit there
      const lh = parseFloat(getComputedStyle(body).lineHeight) || 20;
      body.style.lineHeight = Math.max(lh, TREE_TOP + rows * SUM_ROW) + 'px';

      const base = body.getBoundingClientRect();
      const layer = document.createElement('div');
      layer.className = 'sumtree';
      const drawn = [];
      for (const it of items) {
        const rects = Array.prototype.slice.call(it.node.getClientRects());
        if (!rects.length) continue;
        rects.forEach((r, ri) => {
          it.bars.forEach((b, k) => {
            const bar = document.createElement('div');
            const lone = it.lone && b.name;
            bar.className = 'sumbar' + (it.drop ? ' dropped' : '') +
              (it.mark && b.name ? ' ' + it.mark : '') + (b.name ? '' : ' step') +
              (lone ? ' lone' : '');
            if (it.x) bar.setAttribute('data-x', it.x);
            bar.style.left = (r.left - base.left) + 'px';
            bar.style.width = Math.max(r.width, 20) + 'px';
            bar.style.top = ((r.bottom - base.top) + (it.row + k) * SUM_ROW) + 'px';
            // the label leads, so you know what the number is before you read it
            bar.innerHTML = '<span class="sumval">' + (b.label ? '<i></i>' : '') +
              (b.sum === null ? '' : '<b>' + esc(b.sum) + '</b>') + '</span>';
            layer.appendChild(bar);
            if (ri === 0) drawn.push([bar, b, it]);
          });
        });
      }
      body.appendChild(layer);

      for (const [bar, b, it] of drawn) {
        if (b.label) fitLabel(bar, b.label, b.name, it.lone);
      }
    });
  }

  /* Trim the label from the end, so what survives is the front of the phrase —
     where the verb and the count are. A name that stands over a value never
     disappears entirely: it gives up letters instead, down to a stub. */
  const NAME_STUB = 3;
  const NAME_ROOM = 76;      // a short name is worth spilling past its bracket for
  function fitLabel(bar, label, named, lone) {
    const val = bar.querySelector('.sumval');
    const tag = val.querySelector('i');
    const room = () =>
      Math.max(bar.getBoundingClientRect().width, named ? NAME_ROOM : 0);
    const fits = () => val.getBoundingClientRect().width <= room();

    /* A bracket over one value has nothing to span. When the name will not sit
       inside it, it becomes a line from the name across to the value. */
    if (lone && named) {
      tag.textContent = label;
      if (val.getBoundingClientRect().width > bar.getBoundingClientRect().width) {
        bar.classList.add('leader');
      }
      return;
    }

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

  /* ================================================================ lists
     A variable and a saved roll are the same thing — an expression named by
     its own label — so one pair of functions draws and wires both. All that
     differs is where they are kept and what clicking the name does. */
  const LISTS = {
    var: {
      pane: 'vars', add: '+ add a variable',
      hint: 'A variable holds an expression and is worked out again at every occurrence. ' +
        'It is named by the <code>#&nbsp;name</code> at its end, and its name can only use ' +
        'letters and _. Inside an expression, <code>atk:=d20+5</code> as its own item sets ' +
        'one for that roll alone, and <code>atk::=d20+5</code> rolls it once however often ' +
        'it is mentioned.',
      placeholder: 'd20+5 # name',
      nameHint: 'put this name into the expression',
      load: loadVars,
      keep(list) { pushVars(list); },
      use(item) { typeInto(nameOf(item.expr)); },
      error: varError
    },
    saved: {
      pane: 'saved', add: '+ add a saved roll',
      hint: 'A saved roll is an expression named by the <code>#&nbsp;name</code> at its end. ' +
        'Save the one you are editing with the Save button, or ' +
        '<kbd>Ctrl</kbd>+<kbd>S</kbd>.',
      placeholder: '4d6dl1 # name',
      nameHint: 'put this roll into the expression',
      load: loadSaved,
      keep(list) { store.write(LS_SAVED, list); },
      use(item) { typeInto(item.expr, true); },
      error: savedError
    }
  };

  function renderList(kind) {
    const L = LISTS[kind], host = el[L.pane], list = L.load();
    host.innerHTML =
      '<div class="varhint">' + L.hint + '</div>' +
      list.map((it, i) => {
        const err = L.error(it.expr);
        return '<div class="lrow" data-kind="' + kind + '" data-i="' + i + '" draggable="true">' +
          '<div class="lmain">' +
            '<button class="del" title="remove" tabindex="-1">&times;</button>' +
            '<button class="pin' + (it.mark ? ' on' : '') + '" tabindex="-1" ' +
              'title="show as a shortcut under the expression">★</button>' +
            '<button class="lname" title="' + esc(L.nameHint) + ' — drag to reorder">' +
              (titleOf(it.expr) ? titleHTML(it.expr) : '—') + '</button>' +
            '<input class="lexpr" value="' + esc(it.expr) + '" spellcheck="false" ' +
              'placeholder="' + esc(L.placeholder) + '">' +
            '<span class="step' + (isInt(bodyOf(it.expr)) ? '' : ' off') + '">' +
              stepBtn('vdec') + stepBtn('vinc') + '</span>' +
          '</div>' +
          '<div class="lerr' + (err ? ' on' : '') + '">' + esc(err || '') + '</div>' +
        '</div>';
      }).join('') +
      '<button class="varadd" data-kind="' + kind + '">' + esc(L.add) + '</button>';

    host.querySelectorAll('.lexpr').forEach((inp) => {
      inp.addEventListener('input', () => commitList(kind));
      inp.addEventListener('change', () => commitList(kind));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inp.blur(); });
    });
    wireDrag(kind, host);
  }

  /* Rows are dragged by their name — the one part that is not a field, and the
     part you are looking at when you decide where something belongs. */
  function wireDrag(kind, host) {
    let from = -1;
    host.querySelectorAll('.lrow').forEach((row) => {
      row.addEventListener('dragstart', (ev) => {
        if (!ev.target.closest('.lname')) { ev.preventDefault(); return; }
        from = +row.getAttribute('data-i');
        row.classList.add('lifted');
        ev.dataTransfer.effectAllowed = 'move';
        try { ev.dataTransfer.setData('text/plain', String(from)); } catch (e) { /* ok */ }
      });
      row.addEventListener('dragend', () => {
        from = -1;
        host.querySelectorAll('.lrow').forEach((r) => r.classList.remove('lifted', 'over'));
      });
      row.addEventListener('dragover', (ev) => {
        if (from < 0) return;
        ev.preventDefault();
        host.querySelectorAll('.lrow').forEach((r) => r.classList.remove('over'));
        row.classList.add('over');
      });
      row.addEventListener('drop', (ev) => {
        if (from < 0) return;
        ev.preventDefault();
        const to = +row.getAttribute('data-i');
        if (to === from) return;
        const list = readList(kind);
        list.splice(to, 0, list.splice(from, 1)[0]);
        LISTS[kind].keep(list);
        from = -1;
        renderList(kind); renderShortcuts();
      });
    });
  }

  /** what the rows currently say, which may be ahead of what is stored */
  function readList(kind) {
    const stored = LISTS[kind].load();
    const out = [];
    el[LISTS[kind].pane].querySelectorAll('.lrow').forEach((row, i) => {
      out.push({ expr: row.querySelector('.lexpr').value,
                 mark: !!(stored[i] && stored[i].mark) });
    });
    return out;
  }

  /* Saving must not rebuild the rows, or it would steal the caret mid-word.
     Only the name, the error line and the stepper move. */
  function commitList(kind) {
    const L = LISTS[kind], list = readList(kind);
    L.keep(list);
    el[L.pane].querySelectorAll('.lrow').forEach((row, i) => {
      const it = list[i] || { expr: '' };
      const err = L.error(it.expr);
      const box = row.querySelector('.lerr');
      box.textContent = err || '';
      box.classList.toggle('on', !!err);
      row.querySelector('.lname').innerHTML = titleOf(it.expr) ? titleHTML(it.expr) : '—';
      row.querySelector('.step').classList.toggle('off', !isInt(bodyOf(it.expr)));
    });
    renderShortcuts();
    onInput();                 // the expression may now mean something different
  }

  /** one delegated listener per pane, so redrawing the rows never loses it */
  function wireList(kind) {
    const L = LISTS[kind];
    el[L.pane].addEventListener('click', (ev) => {
      if (ev.target.closest('.varadd')) {
        const list = readList(kind);
        list.push({ expr: '' });
        L.keep(list);
        renderList(kind);
        const box = el[L.pane].querySelector('.lrow:last-of-type .lexpr');
        if (box) box.focus();
        return;
      }
      const row = ev.target.closest('.lrow');
      if (!row) return;
      const i = +row.getAttribute('data-i');
      const list = readList(kind);

      if (ev.target.closest('.lname')) { if (list[i]) L.use(list[i]); return; }
      if (ev.target.closest('.pin')) {
        if (!list[i]) return;
        list[i].mark = !list[i].mark;
        L.keep(list); renderList(kind); renderShortcuts();
        return;
      }
      if (ev.target.closest('.del')) {
        list.splice(i, 1);
        L.keep(list); renderList(kind); renderShortcuts(); onInput();
        return;
      }
      const s = stepDelta(ev);
      if (!s) return;
      const box = row.querySelector('.lexpr');
      const body = bodyOf(box.value);
      if (!isInt(body)) return;
      box.value = withBody(box.value, String(parseInt(body, 10) + s.by));
      commitList(kind);
    });
    el[L.pane].addEventListener('contextmenu', (ev) => {
      const s = stepDelta(ev);
      const row = ev.target.closest('.lrow');
      if (!s || !row) return;
      const box = row.querySelector('.lexpr');
      const body = bodyOf(box.value);
      if (!isInt(body)) return;
      box.value = withBody(box.value, String(parseInt(body, 10) + s.by));
      commitList(kind);
    });
  }

  const renderSaved = () => renderList('saved');

  /* The label names it, so there is nothing to ask for — and nothing that can
     drift out of step with what the expression actually says. */
  function saveCurrent() {
    const expr = el.ta.value.trim();
    if (!expr) return;
    if (!titleOf(expr)) {
      toast('name it first — add # a name to the end');
      return;
    }
    const items = loadSaved().filter((x) => titleOf(x.expr) !== titleOf(expr));
    items.unshift({ expr, mark: false });
    store.write(LS_SAVED, items.slice(0, 60));
    renderSaved(); renderShortcuts();
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

  /* ------------------------------------------------------ what is stored
     A variable is an expression worked out afresh at every occurrence, so
     `2atk` rolls twice. Only variables reach the engine by name; a saved roll
     is only ever loaded into the field. */
  function loadVars() {
    const v = store.read(LS_VARS, null);
    if (Array.isArray(v)) return v.map(normalise);
    return PRESETS.length ? PRESETS[0].vars.map((x) => ({ expr: x.expr, mark: true })) : [];
  }

  function pushVars(list) {
    const map = {};
    for (const v of list) {
      const n = nameOf(v.expr);
      if (n && /^[a-zA-Z_]+$/.test(n)) map[n] = v.expr;
    }
    E.setVars(map);
    store.write(LS_VARS, list);
  }

  const renderVars = () => renderList('var');

  /** the two panes wire themselves the same way */
  function wireLists() { wireList('var'); wireList('saved'); }

  /** a saved roll may be called anything; a variable's name has to be a word */
  function savedError(expr) {
    const src = String(expr || '');
    if (!src.trim()) return null;
    const cut = E.splitLabel(src);
    if (!cut.label) return 'needs a name — write it as # name at the end';
    if (!cut.body.trim()) return 'needs an expression before the # name';
    try { E.parse(cut.body); return null; } catch (e) { return e.message; }
  }

  function varError(expr) {
    const first = savedError(expr);
    if (first) return first;
    const label = nameOf(expr);
    if (label && !/^[a-zA-Z_]+$/.test(label)) return 'a name can only use letters and _';
    return null;
  }

  /* =============================================================== preset
     A preset is everything you have set up — the saved rolls and the
     variables — carried in one link. It lives in localStorage between visits
     like everything else, so a link is only ever a way of moving one about. */
  function renderSetup() {
    const link = setupLink();
    const back = lastImport();
    $('tab-setup').innerHTML =
      '<div class="varhint">Your saved rolls and variables together, kept in this ' +
      'browser between visits. The link below carries them somewhere else: open it there, ' +
      'or paste one here to look it over first. The expression link in the top bar is a ' +
      'different thing — it holds only the roll you last made.</div>' +
      '<div class="setrowb"><label>Yours</label>' +
        '<textarea class="setbox" id="setOut" readonly rows="2">' + esc(link) + '</textarea>' +
        '<button class="varadd" id="setCopy">export</button></div>' +
      '<div class="setrowb"><label>Paste one</label>' +
        '<textarea class="setbox" id="setIn" rows="2" spellcheck="false" ' +
          'placeholder="paste a link here"></textarea>' +
        '<button class="varadd" id="setLoad">import</button></div>' +
      '<div class="setrowb"><label>Or take one</label>' +
        '<div class="presets">' + PRESETS.map((x, i) =>
          '<button class="varadd" data-preset="' + i + '" title="' + esc(x.note || '') + '">' +
          esc(x.name) + '</button>').join('') + '</div></div>' +
      (back ? '<button class="varadd" id="setBack">' +
        (back.whole ? 'put back the preset this replaced' : 'undo the last import&hellip;') +
        '</button>' : '') +
      '<div class="tailroom"></div>';

    $('setCopy').addEventListener('click', () => copy(link, 'link copied', 'could not copy'));
    $('setLoad').addEventListener('click', () => {
      const st = readSetup($('setIn').value);
      if (!st || (!st.vars.length && !st.saved.length)) { toast('that is not a preset link'); return; }
      pickDialog('add', st);
    });
    $('tab-setup').querySelectorAll('[data-preset]').forEach((b) => {
      b.addEventListener('click', () => pickDialog('add', PRESETS[+b.getAttribute('data-preset')]));
    });
    if (back) $('setBack').addEventListener('click', () => {
      if (!back.whole) { pickDialog('remove', back); return; }
      pushVars(back.whole.v || []);
      store.write(LS_SAVED, back.whole.s || []);
      store.write(LS_UNDO, null);
      renderVars(); renderSaved(); renderShortcuts(); renderSetup(); onInput();
      toast('put back');
    });
  }

  /** how an incoming item stands against what is already here */
  function standing(item, kind) {
    const mine = kind === 'v' ? loadVars() : loadSaved();
    const key = (x) => kind === 'v' ? nameOf(x.expr) : titleOf(x.expr);
    const match = mine.find((x) => key(x) === key(item));
    if (!match) return 'new';
    return match.expr === item.expr ? 'same' : 'update';
  }

  /* One dialog for both directions: adding what a link holds, and taking back
     out what the last one added. Anything new or changed starts selected;
     something already here exactly as it is does not, since taking it would
     do nothing. */
  function pickDialog(mode, st) {
    const adding = mode === 'add';
    const rows = (list, kind) => list.map((x, i) => {
      const how = adding ? standing(x, kind) : 'new';
      return '<label class="pickrow ' + how + '">' +
        '<input type="checkbox" checked' + (how === 'same' ? ' disabled' : '') +
          ' data-kind="' + kind + '" data-i="' + i + '">' +
        '<b>' + (titleOf(x.expr) ? titleHTML(x.expr) : '—') + '</b>' +
        '<code>' + esc(bodyOf(x.expr)) + '</code>' +
        (adding ? '<em class="tag">' + how + '</em>' : '') + '</label>';
    }).join('');

    const host = document.createElement('div');
    host.className = 'modal';
    host.innerHTML =
      '<div class="sheet">' +
        '<h3>' + (adding ? 'Take what you want' : 'Put back what you do not') + '</h3>' +
        (st.saved.length ? '<h4>Saved rolls</h4>' + rows(st.saved, 's') : '') +
        (st.vars.length ? '<h4>Variables</h4>' + rows(st.vars, 'v') : '') +
        '<div class="sheetend">' +
          '<button class="varadd" data-go="1">' +
            (adding ? 'add selected' : 'remove selected') + '</button>' +
          (adding ? '<button class="varadd warn" data-all="1">replace everything</button>' : '') +
          '<button class="varadd" data-close="1">cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(host);

    const shut = () => host.remove();
    const done = (n, verb) => {
      shut();
      if ($('setIn')) $('setIn').value = '';
      renderSetup();
      onInput();
      toast(n ? n + ' ' + verb : 'nothing ' + verb);
    };
    host.addEventListener('click', (ev) => {
      if (ev.target === host || ev.target.closest('[data-close]')) { shut(); return; }
      if (ev.target.closest('[data-all]')) { done(replaceSetup(st), 'imported'); return; }
      if (!ev.target.closest('[data-go]')) return;
      const pick = { vars: [], saved: [] };
      host.querySelectorAll('input:checked').forEach((c) => {
        const v = c.getAttribute('data-kind') === 'v';
        const item = (v ? st.vars : st.saved)[+c.getAttribute('data-i')];
        if (item) (v ? pick.vars : pick.saved).push(item);
      });
      done(adding ? addSetup(pick) : dropSetup(pick), adding ? 'imported' : 'removed');
    });
  }

  /* ================================================================= tabs */
  function switchTab(name) {
    state.activeTab = name;
    el.tabs.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('on', b.getAttribute('data-tab') === name));
    ['reference', 'explain', 'details', 'vars', 'saved', 'setup'].forEach((n) =>
      $('tab-' + n).classList.toggle('on', n === name));
    if (name === 'details') renderDetails();
    if (name === 'setup') renderSetup();
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
      el.notation.innerHTML = '';
      el.wrap.classList.remove('bad', 'ok');
      paint(); renderExplain(); renderPreview();
      if (state.activeTab === 'details') renderDetails();
      return;
    }

    try {
      state.inspect = E.inspect(raw);
      state.error = null;
      const p = state.inspect.parsed;
      el.notation.innerHTML = dieText(p.label || '');
      el.status.classList.remove('err');
      el.status.textContent = summarise(p);
      el.wrap.classList.remove('bad');
      el.wrap.classList.add('ok');
    } catch (err) {
      state.error = err;
      state.inspect = null;
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
    growEditor();
    renderExplain();
    syncCaret(true);

    renderPreview();
    if (submitted) commitRoll();

    clearTimeout(detailsTimer);
    if (state.activeTab === 'details') detailsTimer = setTimeout(renderDetails, 300);
  }

  const summarise = () => '✓  syntax valid';

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
    wireLists();
    renderShortcuts();
    wireShortcuts();
    renderSetup();
    switchTab(state.activeTab);   // on a phone that is the reference, not Explain

    // a setup link is adopted whole; anything else in the bar is an expression
    const fromLink = readSetup();
    el.ta.value = readExpr() || store.read(LS_LAST, '') || DEFAULT_EXPR;

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
      growEditor();
      renderPreview();
      if (!wide.matches && state.activeTab === 'reference') switchTab('explain');
      else if (wide.matches && state.activeTab === 'reference') switchTab('explain');
    });

    el.result.addEventListener('click', (ev) => {
      const again = ev.target.closest('[data-again]');
      if (again) {
        const e = state.log[+again.getAttribute('data-again')];
        if (e) { typeInto(e.roll.input, true); commitRoll(); }
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
      syncURL();
      copy(location.href, 'link copied', 'link is in the address bar');
    });
    $('btnUndo').addEventListener('click', () => editUndo('undo'));
    $('btnRedo').addEventListener('click', () => editUndo('redo'));

    setDrawer(store.read(LS_DRAWER, false) === true);
    el.drawer.addEventListener('click', () =>
      setDrawer(!el.paneTools.classList.contains('collapsed')));

    el.tabs.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (!b) return;
      setDrawer(false);                        // tapping a tab always opens the drawer
      switchTab(b.getAttribute('data-tab'));
    });

    // only a person can cause this: replaceState never fires it
    window.addEventListener('hashchange', () => {
      const st = readSetup();
      if (st && (st.vars.length || st.saved.length)) {
        const n = addSetup(st);
        toast(n ? 'preset loaded — ' + n + ' added' : 'preset already loaded');
        renderSetup(); onInput();
        return;
      }
      const e = readExpr();
      if (e !== null && e !== el.ta.value) { el.ta.value = e; onInput(); }
    });

    onInput();
    el.ta.focus();
    el.ta.setSelectionRange(el.ta.value.length, el.ta.value.length);
    if (fromLink && (fromLink.vars.length || fromLink.saved.length)) {
      const n = addSetup(fromLink);
      toast(n ? 'preset loaded — ' + n + ' added' : 'preset already loaded');
      renderSetup();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
