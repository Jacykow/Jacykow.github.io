/* ============================================================================
   Dice sprite generator  —  node tools/gen-dice.js
   ----------------------------------------------------------------------------
   Builds the real polyhedron for each die, rotates it so one face sits up and
   toward the camera, orthographically projects it, culls back faces and shades
   the rest with a Lambert term. The output is a static SVG sprite: no runtime
   3D, just baked paths.

   Faces are painted with `currentColor` at varying opacity over an opaque body,
   so a single CSS colour still drives every state (dropped, success, ...).

   Prints the <symbol> block for index.html and the matching CSS block.
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
    const key = nr.map((x) => x.toFixed(4)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ normal: nr, idx: orderAround(V, on, nr) });
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
  return hullFaces(V).map((f) => {
    const d = dot(f.normal, V[f.idx[0]]);
    return scl(f.normal, 1 / d);
  });
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

/** pentagonal trapezohedron — the d10 — is the dual of a pentagonal antiprism */
function trapezohedron() {
  return dual(antiprism(5));
}

/** n-gonal prism of the given half-height — coins and barrel dice */
function prism(n, h, r = 1) {
  const v = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    v.push([Math.cos(t) * r, h, Math.sin(t) * r], [Math.cos(t) * r, -h, Math.sin(t) * r]);
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

/* --------------------------------------------------------------- upright
   Aligning a face normal to the camera leaves the roll about the view axis
   undefined, so solids land at arbitrary angles and look knocked over. Find
   the in-plane rotation that stands the value face on its mirror axis: an
   edge down for squares/triangles/pentagons, the long axis vertical for the
   d10 kite. Ties are broken toward the wider end being at the bottom, which
   reads as resting rather than balancing. */
function uprightSpin(rel) {
  const rotate = (p, t) => [p[0] * Math.cos(t) - p[1] * Math.sin(t),
                            p[0] * Math.sin(t) + p[1] * Math.cos(t)];
  let best = 0, bestKey = [Infinity, Infinity];
  for (let deg = 0; deg < 360; deg += 0.5) {
    const t = deg * Math.PI / 180;
    const pts = rel.map((p) => rotate(p, t));
    let asym = 0;
    for (const p of pts) {                    // distance to the mirrored set
      let m = Infinity;
      for (const q of pts) m = Math.min(m, Math.hypot(p[0] + q[0], p[1] - q[1]));
      asym += m;
    }
    asym = Math.round(asym * 1000) / 1000;
    const lowMass = -pts.reduce((s, p) => s + p[1], 0) / pts.length;  // screen y is down
    const key = [asym, lowMass];
    if (key[0] < bestKey[0] - 1e-6 || (Math.abs(key[0] - bestKey[0]) < 1e-6 && key[1] < bestKey[1])) {
      bestKey = key; best = deg;
    }
  }
  return best;
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
const LIGHT = norm([-0.35, 0.72, 0.6]);
// Where the value face points. Kept close to the camera on purpose: a steeper
// tilt foreshortens the face until the digit is unreadable at 20px, which is
// the size that actually matters here.
const TARGET = norm([0.10, 0.26, 0.96]);
const BOX = 64, MARGIN = 3.2;

function build(name, verts, opts) {
  opts = opts || {};
  const V0 = verts;
  const faces = hullFaces(V0);

  // choose the face that will carry the value, then bring it to `target`.
  // Solids with widely spaced normals (the tetrahedron) need a steeper tilt
  // before any second face comes into view, or they project dead flat.
  const target = opts.target ? norm(opts.target) : TARGET;
  let pick = 0;
  if (opts.faceSides) {
    pick = faces.findIndex((f) => f.idx.length === opts.faceSides);
    if (pick < 0) pick = 0;
  }
  const n0 = faces[pick].normal;
  let V = V0.map((v) => align(v, n0, target));

  // stand it upright, then apply any deliberate offset on top
  if (opts.upright !== false) {
    const fp = faces[pick].idx.map((i) => [V[i][0], -V[i][1]]);
    const cx = fp.reduce((s, p) => s + p[0], 0) / fp.length;
    const cy = fp.reduce((s, p) => s + p[1], 0) / fp.length;
    const deg = uprightSpin(fp.map((p) => [p[0] - cx, p[1] - cy]));
    V = V.map((v) => rot(v, target, -deg * Math.PI / 180));
  }
  if (opts.spin) V = V.map((v) => rot(v, target, opts.spin * Math.PI / 180));

  const F = faces.map((f) => {
    const pts = f.idx.map((i) => V[i]);
    const c = scl(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
    const nr = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    return { pts, c, nr: dot(nr, c) < 0 ? scl(nr, -1) : nr };
  });

  // orthographic projection, y flipped for screen space
  const all = [].concat.apply([], F.map((f) => f.pts));
  const xs = all.map((p) => p[0]), ys = all.map((p) => -p[1]);
  const spanX = Math.max.apply(null, xs) - Math.min.apply(null, xs);
  const spanY = Math.max.apply(null, ys) - Math.min.apply(null, ys);
  const s = (BOX - MARGIN * 2) / Math.max(spanX, spanY);
  const cx = (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2;
  const cy = (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2;
  const proj = (p) => [BOX / 2 + (p[0] - cx) * s, BOX / 2 + (-p[1] - cy) * s];

  const visible = F.filter((f) => f.nr[2] > 0.001);
  visible.sort((a, b) => a.c[2] - b.c[2]);

  const hull = convexHull2([].concat.apply([], visible.map((f) => f.pts.map(proj))));

  // Lambert shade -> fill opacity
  const shade = (nr) => {
    const l = Math.max(0, dot(nr, LIGHT));
    return (0.06 + 0.30 * Math.pow(l, 0.8)).toFixed(3);
  };

  let body = '      <path d="' + pathOf(hull) + '"/>\n';
  let cells = '';
  for (const f of visible) {
    cells += '      <path d="' + pathOf(f.pts.map(proj)) + '" fill="currentColor" fill-opacity="' +
      shade(f.nr) + '" stroke-opacity=".33" stroke-width="1.1"/>\n';
  }
  const outline = '      <path d="' + pathOf(hull) + '" fill="none" stroke-width="2.6"/>\n';

  // where the value goes: centre of the face we aimed at the camera
  const top = F[pick];
  let tc = proj(top.c);
  let ext = Math.max.apply(null, top.pts.map((p) => {
    const q = proj(p);
    return Math.hypot(q[0] - tc[0], q[1] - tc[1]);
  }));
  if (opts.centreValue) {                        // spheres read the same all over
    tc = [BOX / 2, BOX / 2];
    ext = (BOX - MARGIN * 2) / 2;
  }

  return {
    name,
    svg: '    <symbol id="sh-' + name + '">\n' + body + cells + outline + '    </symbol>',
    nx: +tc[0].toFixed(1),
    ny: +tc[1].toFixed(1),
    ext: +ext.toFixed(1),
    faces: faces.length,
    drawn: visible.length
  };
}

/* ------------------------------------------------------------------ shapes */
const SHAPES = [
  build('d2', prism(28, 0.17), { faceSides: 28, target: [0, 0.55, 0.84], upright: false }),
  build('d4', tetrahedron(), { target: [0.10, 0.52, 0.85] }),
  build('d6', cube(), { faceSides: 4 }),
  build('d8', octahedron(), {}),
  build('d10', trapezohedron(), { faceSides: 4 }),
  build('d12', dodecahedron(), { faceSides: 5 }),
  build('d20', icosahedron(), {}),
  build('d100', icosphere(), { centreValue: true, upright: false }),
  build('gen', prism(7, 0.62), { faceSides: 4 })
];

/* ------------------------------------------------------------------ output */
const svg = SHAPES.map((s) => s.svg).join('\n');
// ext is the face's circumradius; a digit wants roughly 1.2x its inradius,
// and a regular face's inradius is about 0.72 of its circumradius.
const css = SHAPES.map((s) =>
  '.s-' + s.name + '{--nx:' + s.nx + '; --ny:' + s.ny + '; --nsz:' +
  Math.max(0.21, Math.min(0.40, (s.ext * 0.72 * 1.2) / 64)).toFixed(3) + '}'
).join('\n');

console.log('<!-- generated by tools/gen-dice.js -->');
console.log(svg);
console.log('\n/* generated by tools/gen-dice.js */');
console.log(css);
console.error('\nfaces drawn / total:');
for (const s of SHAPES) console.error('  ' + s.name.padEnd(5) + s.drawn + '/' + s.faces +
  '  value face at (' + s.nx + ',' + s.ny + ') ext ' + s.ext);
