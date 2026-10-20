// Calileon brand mark geometry.
//
// The mark is a single tapered brush stroke: a chameleon whose head sits at
// the upper-right end of a "C" and whose tail spirals inward at the bottom,
// echoing the painterly master (public/werw_1.png) in a form that survives
// 16px favicons. Everything is generated from a centerline + width profile so
// it can be tweaked numerically and stays reproducible.

const VIEW = 512;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Centerline: arc of the "C", then a clothoid-like inward tail curl. */
const centerline = (opts) => {
  const { cx, cy, R, startDeg, bodyDeg, tailLen, tailEndR, n } = opts;
  const pts = [];
  const bodyLen = (Math.PI * R * bodyDeg) / 180;
  const total = bodyLen + tailLen;
  let h = ((startDeg - 90) * Math.PI) / 180; // travel heading (theta decreasing)
  let x = cx + R * Math.cos((startDeg * Math.PI) / 180);
  let y = cy + R * Math.sin((startDeg * Math.PI) / 180);
  const steps = 4000;
  const ds = total / steps;
  const raw = [];
  for (let i = 0; i <= steps; i++) {
    const s = i * ds;
    raw.push({ x, y, h, s });
    let k = -1 / R;
    if (s > bodyLen) {
      const u = (s - bodyLen) / tailLen;
      // curvature ramps from the body radius to the tight tail radius
      k = -(1 / R + (1 / tailEndR - 1 / R) * Math.pow(u, 1.6));
    }
    x += Math.cos(h) * ds;
    y += Math.sin(h) * ds;
    h += k * ds;
  }
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // denser sampling at both ends where the shape changes fastest
    const tt = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const p = raw[Math.round(tt * steps)];
    pts.push({ ...p, t: p.s / total });
  }
  return pts;
};

/** Stroke half-width along normalized length t (0 = snout, 1 = tail tip). */
const width = (t, W) => {
  const snout = Math.sqrt(Math.min(1, t / 0.075)); // rounded, slightly pointed snout
  const head = 1.12 - 0.14 * smoothstep(0.1, 0.2, t); // head a bit fuller than the neck
  const taper = 1 - 0.88 * Math.pow(smoothstep(0.38, 1, t), 0.9);
  return (W / 2) * snout * head * taper;
};

const fmt = (v) => (Math.round(v * 10) / 10).toString();

/** Catmull-Rom -> cubic Bezier through the given points. */
const smoothPath = (pts, move = true) => {
  let d = move ? `M${fmt(pts[0].x)} ${fmt(pts[0].y)}` : "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2.x)} ${fmt(
      p2.y,
    )}`;
  }
  return d;
};

export const DEFAULT_MARK = {
  cx: 250,
  cy: 262,
  R: 168,
  startDeg: -38,
  bodyDeg: 262,
  tailLen: 250,
  tailEndR: 22,
  W: 96,
  crest: 0.34,
  crestAt: 0.135,
  n: 96,
};

export const buildMark = (opts = DEFAULT_MARK) => {
  const line = centerline(opts);
  const left = [];
  const right = [];
  for (const p of line) {
    const w = width(p.t, opts.W);
    // chameleon casque: a crest bump on the outer edge just behind the eye
    // rises gently from the eye, drops off sharply at the back of the head
    const ct = p.t - opts.crestAt;
    const crest =
      1 + opts.crest * Math.exp(-Math.pow(ct / (ct < 0 ? 0.05 : 0.018), 2));
    // normal pointing to the inside of the curl; the crest goes on the outside
    const nx = Math.sin(p.h);
    const ny = -Math.cos(p.h);
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w * crest, y: p.y - ny * w * crest });
  }
  // center the outline's bounding box in the view
  const all = left.concat(right);
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const dx = VIEW / 2 - (minX + maxX) / 2;
  const dy = VIEW / 2 - (minY + maxY) / 2;
  for (const p of all) {
    p.x += dx;
    p.y += dy;
  }
  for (const p of line) {
    p.x += dx;
    p.y += dy;
  }
  const tipR = width(1, opts.W);
  const back = right.slice().reverse();
  const body =
    `${smoothPath(left)}` +
    `A${fmt(tipR)} ${fmt(tipR)} 0 0 1 ${fmt(back[0].x)} ${fmt(back[0].y)}` +
    `${smoothPath(back, false)}Z`;

  // eye: on the head, nudged towards the outside of the curl
  const e = line.find((p) => p.t >= 0.085);
  const ew = width(e.t, opts.W);
  const eye = {
    x: e.x + Math.sin(e.h) * ew * 0.18,
    y: e.y - Math.cos(e.h) * ew * 0.18,
    r: ew * 0.5,
    pupil: ew * 0.27,
  };
  const size = Math.max(maxX - minX, maxY - minY);
  return { body, eye, view: VIEW, size };
};
