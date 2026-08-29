/* ============================================================================
   Dice sprite generator  —  node tools/gen-dice.js
   ----------------------------------------------------------------------------
   Builds the real polyhedron for each die, lays it to rest on a face, views it
   through one shared camera, culls back faces and shades the rest with a
   Lambert term. The output is a static SVG sprite: no runtime 3D, just baked
   paths.

   Faces are painted with `currentColor` at varying opacity over an opaque body,
   so a single CSS colour still drives every state (dropped, success, ...). The
   value is drawn centred at a constant size, so nothing per-shape is emitted.

   Prints the <symbol> block for index.html; run tools/splice.js to install it.
   ========================================================================== */
'use strict';

const PHI = (1 + Math.sqrt(5)) / 2;
const EPS = 1e-6;

/* ------------------------------------------------------------ vec3 helpers */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a) => scl(a, 1 / len(a));

/* --------------------------------------------------- faces of a convex hull
   Brute force over vertex triples: a triple defines a face when every other
   vertex lies on one side of its plane. Vertex counts here are <= 42, so the
   O(n^3) pass is irrelevant and it saves hardcoding face tables per solid. */
function hullFaces(V) {
  const n = V.length, out = [], seen = new Set();
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    let nr = cross(sub(V[j], V[i]), sub(V[k], V[i]));
    if (len(nr) < 1e-9) continue;
    nr = norm(nr);
    let d = dot(nr, V[i]);
    if (d < 0) { nr = scl(nr, -1); d = -d; }
    if (d < 1e-9) continue;                       // plane through the centre
    let ok = true; const on = [];
    for (let t = 0; t < n; t++) {
      const dt = dot(nr, V[t]);
      if (dt > d + 1e-4) { ok = false; break; }
      if (Math.abs(dt - d) < 1e-4) on.push(t);
    }
    if (!ok || on.length < 3) continue;
    // -0 and 0 stringify differently, which silently duplicates faces
    const key = nr.map((x) => (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const idx = orderAround(V, on, nr);
    // drop slivers: near-duplicate vertices can otherwise fabricate a face
    let area = 0;
    for (let t = 1; t + 1 < idx.length; t++) {
      area += len(cross(sub(V[idx[t]], V[idx[0]]), sub(V[idx[t + 1]], V[idx[0]]))) / 2;
    }
    if (area < 1e-3) continue;
    out.push({ normal: nr, idx, area });
  }
  return out;
}

/** wind a face's vertices counter-clockwise about its normal */
function orderAround(V, idx, nr) {
  const c = scl(idx.reduce((a, i) => add(a, V[i]), [0, 0, 0]), 1 / idx.length);
  let u = Math.abs(nr[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  u = norm(cross(nr, u));
  const w = cross(nr, u);
  return idx.slice().sort((a, b) => {
    const pa = sub(V[a], c), pb = sub(V[b], c);
    return Math.atan2(dot(pa, w), dot(pa, u)) - Math.atan2(dot(pb, w), dot(pb, u));
  });
}

/* ------------------------------------------------------------- rotations */
/** Rodrigues rotation of v about unit axis k by angle t */
function rot(v, k, t) {
  const c = Math.cos(t), s = Math.sin(t);
  return add(add(scl(v, c), scl(cross(k, v), s)), scl(k, dot(k, v) * (1 - c)));
}

/** rotation taking unit vector a onto unit vector b, applied to v */
function align(v, a, b) {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  if (d > 1 - 1e-9) return v;
  if (d < -1 + 1e-9) {                            // opposite: spin 180 about any perp
    let p = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return rot(v, norm(cross(a, p)), Math.PI);
  }
  return rot(v, norm(cross(a, b)), Math.acos(d));
}

/* ------------------------------------------------------------- geometries */
function tetrahedron() {
  return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
}
function cube() {
  const v = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
  return v;
}
function octahedron() {
  return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
}
function icosahedron() {
  const v = [];
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    v.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s1 * PHI, 0, s2]);
  }
  return v;
}
function dodecahedron() {
  const v = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
  const a = 1 / PHI;
  for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
    v.push([0, s1 * a, s2 * PHI], [s1 * a, s2 * PHI, 0], [s1 * PHI, 0, s2 * a]);
  }
  return v;
}

/** polar dual: every face plane of the input becomes a vertex */
function dual(V) {
  const out = [], seen = new Set();
  for (const f of hullFaces(V)) {
    const p = scl(f.normal, 1 / dot(f.normal, V[f.idx[0]]));
    const k = p.map((x) => x.toFixed(4)).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** n-gonal antiprism: two rings offset by half a step. `h` is set so every
    edge has the same length, which makes the dual a uniform trapezohedron. */
function antiprism(n) {
  const step = 360 / n, s = 2 * Math.sin(Math.PI / n);       // ring edge length
  const u = [1 - Math.cos(step / 2 * Math.PI / 180), Math.sin(step / 2 * Math.PI / 180)];
  const h = Math.sqrt(Math.max(0, s * s - (u[0] * u[0] + u[1] * u[1]))) / 2;
  const V = [];
  for (let i = 0; i < n; i++) {
    const a = i * step * Math.PI / 180, b = (i * step + step / 2) * Math.PI / 180;
    V.push([Math.cos(a), h, Math.sin(a)], [Math.cos(b), -h, Math.sin(b)]);
  }
  return V;
}

/** Pentagonal trapezohedron — the d10 — is the dual of a pentagonal antiprism.
    The uniform solid comes out 4 tall by 2.2 wide, far more elongated than any
    real d10, so squash it down the axis. A linear map keeps every face planar,
    so the kites stay flat. */
function trapezohedron(squash) {
  const k = squash == null ? 0.54 : squash;
  return dual(antiprism(5)).map((v) => [v[0], v[1] * k, v[2]]);
}

/** n-gonal prism of the given half-height — the coin, and the odd-sided
    barrels. Made long enough that it can only come to rest on a side. */
function prism(n, h, r = 1) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    v.push([Math.cos(t) * r, h, Math.sin(t) * r], [Math.cos(t) * r, -h, Math.sin(t) * r]);
  }
  return v;
}

/** n-gonal bipyramid: an n-gon equator with an apex above and below, giving
    2n triangular faces. This is how even-sided dice without a Platonic solid
    are actually made (d14, d16, d18). */
function bipyramid(n, h) {
  const v = [[0, h, 0], [0, -h, 0]];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    v.push([Math.cos(t), 0, Math.sin(t)]);
  }
  return v;
}

/** frequency-2 icosphere — stands in for the near-spherical zocchihedron */
function icosphere() {
  const base = icosahedron().map(norm);
  const faces = hullFaces(base);
  const out = [], key = new Map();
  const push = (p) => {
    const k = p.map((x) => x.toFixed(4)).join(',');
    if (!key.has(k)) { key.set(k, out.length); out.push(p); }
    return key.get(k);
  };
  base.forEach(push);
  for (const f of faces) {
    for (let i = 0; i < f.idx.length; i++) {
      const a = base[f.idx[i]], b = base[f.idx[(i + 1) % f.idx.length]];
      push(norm(scl(add(a, b), 0.5)));
    }
    // face centre, so the sphere reads as many small facets
    push(norm(scl(f.idx.reduce((s, i) => add(s, base[i]), [0, 0, 0]), 1 / f.idx.length)));
  }
  return out;
}

/* ------------------------------------------------------------- 2D helpers */
function convexHull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (src) => {
    const h = [];
    for (const q of src) {
      while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return half(p).concat(half(p.reverse()));
}

const f1 = (x) => (Math.round(x * 10) / 10).toString();
const pathOf = (pts) => 'M' + pts.map((p) => f1(p[0]) + ' ' + f1(p[1])).join('L') + 'Z';

/* ------------------------------------------------------------------ build */
const LIGHT = norm([-0.34, 0.70, 0.63]);

/* One camera for every die, so the perspective is identical across the set.
   The solid is first laid to rest on a face (that face's normal points at the
   floor), then only this fixed tilt is applied. PITCH is the camera's
   elevation above the table: too low and the top face foreshortens away, too
   high and the sides vanish and it reads flat again. */
const PITCH = 63 * Math.PI / 180;
const BOX = 64, MARGIN = 2.2;

const tilt = (v) => [v[0],
                     v[1] * Math.cos(PITCH) - v[2] * Math.sin(PITCH),
                     v[1] * Math.sin(PITCH) + v[2] * Math.cos(PITCH)];

const spinY = (v, t) => [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1],
                         -v[0] * Math.sin(t) + v[2] * Math.cos(t)];

const centroid = (pts) => scl(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

function build(name, verts, opts) {
  opts = opts || {};
  const faces = hullFaces(verts);

  // 1. lay it on a face: that face's normal points straight down
  let rest = opts.restFace || 0;
  if (opts.restSides) {
    const i = faces.findIndex((f) => f.idx.length === opts.restSides);
    if (i >= 0) rest = i;
  }
  const laid = verts.map((v) => align(v, faces[rest].normal, [0, -1, 0]));

  const facesOf = (V) => faces.map((f) => {
    const pts = f.idx.map((i) => V[i]);
    const c = centroid(pts);
    const nr = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    return { pts, c, nr: dot(nr, c) < 0 ? scl(nr, -1) : nr, n: f.idx.length };
  });

  // 2. spin about the (vertical) resting axis until the silhouette is
  //    symmetric on screen. This keeps the die flat on the floor while
  //    stopping it from looking randomly slewed.
  let bestSpin = 0;
  if (opts.axisAlongX) {
    // A barrel lying on a side face can still point anywhere in the ground
    // plane, and both the across-view and end-on orientations are symmetric.
    // Aim its long axis across the view directly so every odd die matches.
    const ax = align([0, 1, 0], faces[rest].normal, [0, -1, 0]);
    bestSpin = Math.atan2(ax[2], ax[0]) * 180 / Math.PI;
  } else if (opts.spinSearch !== false) {
    let bestScore = Infinity;
    for (let deg = 0; deg < 360; deg += 0.5) {
      const t = deg * Math.PI / 180;
      const V = laid.map((v) => tilt(spinY(v, t)));
      const F = facesOf(V);
      const pts = [].concat.apply([], F.filter((f) => f.nr[2] > 0.001).map((f) => f.pts))
        .map((p) => [p[0], -p[1]]);
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      // A barrel is symmetric both across the view and end-on. Keep only the
      // across-the-view answer so every odd die lies the same way.
      if (opts.preferWide) {
        const xr = Math.max.apply(null, pts.map((p) => p[0])) - Math.min.apply(null, pts.map((p) => p[0]));
        const yr = Math.max.apply(null, pts.map((p) => p[1])) - Math.min.apply(null, pts.map((p) => p[1]));
        if (yr > xr) continue;
      }
      let asym = 0;
      for (const p of pts) {
        let m = Infinity;
        for (const q of pts) m = Math.min(m, Math.hypot((p[0] - cx) + (q[0] - cx), p[1] - q[1]));
        asym += m;
      }
      if (asym < bestScore - 1e-6) { bestScore = asym; bestSpin = deg; }
    }
  }
  const spin = (bestSpin + (opts.spin || 0)) * Math.PI / 180;

  // 3. apply the shared camera
  const V = laid.map((v) => tilt(spinY(v, spin)));
  const F = facesOf(V);

  // 4. orthographic projection, screen y down
  const all = [].concat.apply([], F.map((f) => f.pts));
  const xs = all.map((p) => p[0]), ys = all.map((p) => -p[1]);
  const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  const s = (BOX - MARGIN * 2) / Math.max(maxX - minX, maxY - minY);
  const cx = (maxX + minX) / 2, cy = (maxY + minY) / 2;
  const proj = (p) => [BOX / 2 + (p[0] - cx) * s, BOX / 2 + (-p[1] - cy) * s];

  const visible = F.filter((f) => f.nr[2] > 0.001);
  visible.sort((a, b) => a.c[2] - b.c[2]);
  const hull = convexHull2([].concat.apply([], visible.map((f) => f.pts.map(proj))));

  const shade = (nr) => (0.05 + 0.34 * Math.pow(Math.max(0, dot(nr, LIGHT)), 0.75)).toFixed(3);

  let cells = '';
  for (const f of visible) {
    cells += '      <path d="' + pathOf(f.pts.map(proj)) + '" fill="currentColor" fill-opacity="' +
      shade(f.nr) + '" stroke-opacity=".30" stroke-width="1"/>\n';
  }
  const body = '      <path d="' + pathOf(hull) + '"/>\n';
  const outline = '      <path d="' + pathOf(hull) + '" fill="none" stroke-width="2.6"/>\n';

  // The value is drawn centred at a constant size for every die, so there is
  // no per-shape face fitting to do here.
  return {
    name,
    svg: '    <symbol id="sh-' + name + '">\n' + body + cells + outline + '    </symbol>',
    spin: bestSpin,
    aspect: +((maxY - minY) / (maxX - minX)).toFixed(2),
    faces: faces.length,
    drawn: visible.length
  };
}

/* ------------------------------------------------------------------ shapes */
/* Odd-sided dice are long n-gonal barrels resting on a side face; even-sided
   ones without a Platonic solid are n/2-gon bipyramids. */
const BARREL = 1.35;   // half-length: long enough never to land on an end
const BIPY = 1.18;     // apex height above the equator

const SHAPES = [
  build('d2', prism(28, 0.16), { restSides: 28, spinSearch: false }),
  build('d4', tetrahedron(), { spin: 60 }),
  build('d5', prism(5, BARREL), { restSides: 4, axisAlongX: true }),
  build('d6', cube(), {}),
  build('d7', prism(7, BARREL), { restSides: 4, axisAlongX: true }),
  build('d8', octahedron(), {}),
  build('d9', prism(9, BARREL), { restSides: 4, axisAlongX: true }),
  build('d10', trapezohedron(), {}),
  build('d11', prism(11, BARREL), { restSides: 4, axisAlongX: true }),
  build('d12', dodecahedron(), {}),
  build('d14', bipyramid(7, BIPY), {}),
  build('d16', bipyramid(8, BIPY), {}),
  build('d18', bipyramid(9, BIPY), {}),
  build('d20', icosahedron(), {}),
  build('d100', icosphere(), { spinSearch: false })
];

/* ------------------------------------------------------------------ output */
console.log('<!-- generated by tools/gen-dice.js -->');
console.log(SHAPES.map((s) => s.svg).join('\n'));

console.error('\n  shape   faces drawn   aspect   spin');
for (const s of SHAPES) console.error('  ' + s.name.padEnd(8) +
  (s.drawn + '/' + s.faces).padEnd(13) + String(s.aspect).padEnd(9) +
  Math.round(s.spin) + '°');
