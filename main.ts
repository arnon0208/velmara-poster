// VELMARA — The Floating Isles
// A travel poster for a place that does not exist, drawn procedurally and
// written to /output/entry.png. No network, no assets, no wall clock:
// every pixel is computed from a fixed seed, so two runs are byte-identical.
//
// Entry: main.ts (Node 22). Run: node main.ts
// Output: /output/entry.png — 768x1024 PNG, well under the 1 MiB cap.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 768;
const H = 1024;
const OUT = "/output/entry.png";

// ---------- deterministic PRNG (mulberry32, fixed seed) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261121);

// ---------- color helpers ----------
type RGB = [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------- canvas (RGB, alpha compositing) ----------
const buf = new Uint8Array(W * H * 3);

function blend(x: number, y: number, c: RGB, alpha: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || alpha <= 0) return;
  const i = (y * W + x) * 3;
  if (alpha >= 1) {
    buf[i] = c[0];
    buf[i + 1] = c[1];
    buf[i + 2] = c[2];
    return;
  }
  buf[i] = clamp255(buf[i] + (c[0] - buf[i]) * alpha);
  buf[i + 1] = clamp255(buf[i + 1] + (c[1] - buf[i + 1]) * alpha);
  buf[i + 2] = clamp255(buf[i + 2] + (c[2] - buf[i + 2]) * alpha);
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(W, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H, Math.ceil(y1));
  for (let y = ya; y < yb; y++) {
    let i = (y * W + xa) * 3;
    for (let x = xa; x < xb; x++) {
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      i += 3;
    }
  }
}

// Vertical gradient over [y0, y1]; stops are [position 0..1, color].
function vgrad(y0: number, y1: number, stops: Array<[number, RGB]>): void {
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(H, Math.ceil(y1));
  for (let y = ya; y < yb; y++) {
    const t = (y - y0) / (y1 - y0);
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const c = mix(c0, c1, f);
    let i = (y * W) * 3;
    for (let x = 0; x < W; x++) {
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      i += 3;
    }
  }
}

// Soft disc: alpha falls to 0 over `soft` px inside the rim.
function disc(cx: number, cy: number, r: number, c: RGB, alpha = 1, soft = 0): void {
  const x0 = Math.max(0, Math.floor(cx - r - soft));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + soft));
  const y0 = Math.max(0, Math.floor(cy - r - soft));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + soft));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r + soft) continue;
      const a = alpha * (soft > 0 ? 1 - smooth(r - soft, r, d) : 1);
      blend(x, y, c, a);
    }
  }
}

// Soft ellipse: normalized distance, alpha falls off past 0.75.
function ellipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: RGB,
  alpha = 1,
  soft = 0.25,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      const a = alpha * (1 - smooth(1 - soft, 1, d));
      blend(x, y, c, a);
    }
  }
}

// Radial glow: alpha ~ (1 - d/r)^2.
function glow(cx: number, cy: number, r: number, c: RGB, alpha: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= r) continue;
      const f = 1 - d / r;
      blend(x, y, c, alpha * f * f);
    }
  }
}

// Scanline polygon fill (even-odd).
function poly(pts: Array<[number, number]>, c: RGB, alpha = 1): void {
  let minY = H;
  let maxY = 0;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1p] = pts[i];
      const [x2, y2p] = pts[(i + 1) % pts.length];
      if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
        xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.floor(xs[k]));
      const xb = Math.min(W - 1, Math.ceil(xs[k + 1]));
      for (let x = xa; x <= xb; x++) blend(x, y, c, alpha);
    }
  }
}

// Thick line with round caps and 1px anti-aliased edge.
function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  w: number,
  c: RGB,
  alpha = 1,
): void {
  const r = w / 2;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1));
  const x1b = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1));
  const y1b = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + r + 1));
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1b; y++) {
    for (let x = x0; x <= x1b; x++) {
      let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > r + 1) continue;
      const a = alpha * (1 - smooth(r - 1, r + 1, d));
      blend(x, y, c, a);
    }
  }
}

// ---------- the poster ----------
const IVORY = hex("#f8efdc");
const GOLD = hex("#ffd98a");
const DEEP = hex("#2c2140");
const PLUM = hex("#4a3560");

// 1. Dusk sky, deep indigo at the top to gold at the horizon.
vgrad(0, 780, [
  [0.0, hex("#221d4b")],
  [0.28, hex("#4a3670")],
  [0.48, hex("#8a5578")],
  [0.64, hex("#d97b6c")],
  [0.78, hex("#f2a56b")],
  [0.9, hex("#f7cf8a")],
  [1.0, hex("#f9dc9e")],
]);

// 2. Early stars in the upper sky.
for (let i = 0; i < 70; i++) {
  const x = 20 + rnd() * (W - 40);
  const y = 16 + rnd() * 280;
  const r = 0.6 + rnd() * 1.1;
  disc(x, y, r, hex("#ffe9c4"), 0.25 + rnd() * 0.55, 0.6);
}

// 3. Low golden sun, behind the hero island.
glow(522, 468, 250, hex("#ffd98a"), 0.5);
disc(522, 468, 44, hex("#ffedb0"), 1, 1);
disc(522, 468, 33, hex("#fff6d8"), 1, 1);

// 4. Far islands, pale lavender silhouettes in the haze.
function farIsland(cx: number, top: number, w: number, tip: number, c: RGB): void {
  poly(
    [
      [cx - w / 2, top + 8],
      [cx - w * 0.32, top],
      [cx + w * 0.3, top + 2],
      [cx + w / 2, top + 10],
      [cx + w * 0.22, top + (tip - top) * 0.55],
      [cx, tip],
      [cx - w * 0.2, top + (tip - top) * 0.55],
    ],
    c,
    0.55,
  );
}
farIsland(130, 470, 150, 560, hex("#8a6f9e"));
farIsland(645, 428, 118, 512, hex("#9a7fae"));
ellipse(130, 566, 70, 12, hex("#e8c9a8"), 0.35);
ellipse(645, 518, 55, 10, hex("#e8c9a8"), 0.35);

// 5. A small hot-air balloon drifting near the sun.
(function balloon(): void {
  const bx = 178;
  const by = 288;
  line(bx - 8, by + 26, bx - 4, by + 40, 2, hex("#6b4a2f"), 0.9);
  line(bx + 8, by + 26, bx + 4, by + 40, 2, hex("#6b4a2f"), 0.9);
  fillRect(bx - 6, by + 40, bx + 6, by + 50, hex("#6b4a2f"));
  ellipse(bx, by, 26, 32, hex("#e2604d"), 1, 0.12);
  ellipse(bx, by, 12, 32, hex("#c74a3a"), 0.9, 0.12);
  ellipse(bx, by, 4, 32, hex("#f2a56b"), 0.9, 0.12);
})();

// 6. Birds: small dark chevrons in the open sky.
for (let i = 0; i < 7; i++) {
  const bx = 260 + rnd() * 330;
  const by = 190 + rnd() * 150;
  const s = 6 + rnd() * 6;
  line(bx - s, by, bx, by - s * 0.45, 2.2, DEEP, 0.75);
  line(bx, by - s * 0.45, bx + s, by, 2.2, DEEP, 0.75);
}

// 7. Mid island, left, smaller and further away.
(function midIsland(): void {
  const cx = 165;
  poly(
    [
      [cx - 95, 548],
      [cx - 60, 540],
      [cx + 62, 542],
      [cx + 95, 550],
      [cx + 55, 600],
      [cx + 18, 652],
      [cx, 672],
      [cx - 20, 650],
      [cx - 58, 598],
    ],
    hex("#6d4a68"),
    1,
  );
  ellipse(cx, 544, 96, 15, hex("#3e7a55"), 1, 0.2);
  // One lighter facet so the cliff is not a flat triangle.
  poly(
    [
      [cx - 95, 548],
      [cx - 30, 544],
      [cx - 22, 600],
      [cx - 58, 598],
    ],
    hex("#8a5f78"),
    0.7,
  );
  poly(
    [
      [cx - 30, 544],
      [cx - 22, 512],
      [cx - 14, 544],
    ],
    hex("#27543a"),
    1,
  );
  poly(
    [
      [cx + 18, 544],
      [cx + 26, 516],
      [cx + 34, 544],
    ],
    hex("#2f6b45"),
    1,
  );
  ellipse(cx, 676, 46, 9, hex("#eec9a8"), 0.4);
})();

// 8. Hero island: grass top, rocky cliff, lighthouse, cottage, waterfalls.
(function heroIsland(): void {
  // Cliff: wide top tapering to a point below.
  poly(
    [
      [295, 598],
      [645, 598],
      [612, 660],
      [562, 720],
      [502, 762],
      [470, 782],
      [438, 760],
      [386, 716],
      [330, 656],
    ],
    hex("#6d4a68"),
    1,
  );
  // Rock facets: lighter left, darker right.
  poly(
    [
      [295, 598],
      [430, 598],
      [420, 660],
      [380, 716],
      [330, 656],
    ],
    hex("#8a5f78"),
    0.8,
  );
  poly(
    [
      [540, 598],
      [645, 598],
      [612, 660],
      [562, 720],
      [520, 742],
      [500, 690],
    ],
    hex("#54384f"),
    0.85,
  );
  // Grassy top.
  ellipse(470, 596, 178, 22, hex("#4c9a63"), 1, 0.2);
  ellipse(470, 592, 150, 14, hex("#57a06b"), 1, 0.2);
  line(292, 600, 648, 600, 3, hex("#2f6b45"), 0.8);

  // Cottage with a terracotta roof.
  fillRect(368, 566, 414, 596, hex("#f2e3c8"));
  poly(
    [
      [360, 568],
      [391, 540],
      [422, 568],
    ],
    hex("#c65a45"),
    1,
  );
  fillRect(386, 578, 396, 596, hex("#4a3560"));

  // Cypress trees.
  poly([[596, 598], [606, 548], [616, 598]], hex("#27543a"), 1);
  poly([[622, 598], [630, 560], [638, 598]], hex("#2f6b45"), 1);
  disc(340, 574, 16, hex("#3a7a4e"), 1, 2);
  line(340, 574, 340, 596, 4, hex("#4a3560"), 1);

  // Lighthouse: white tower, coral bands, warm lamp.
  poly(
    [
      [505, 600],
      [512, 502],
      [528, 502],
      [535, 600],
    ],
    hex("#f5efe0"),
    1,
  );
  poly(
    [
      [508, 566],
      [532, 566],
      [533, 580],
      [507, 580],
    ],
    hex("#d95f4b"),
    1,
  );
  poly(
    [
      [510, 528],
      [530, 528],
      [531, 542],
      [509, 542],
    ],
    hex("#d95f4b"),
    1,
  );
  fillRect(504, 496, 536, 504, hex("#2c2140"));
  fillRect(513, 484, 527, 496, hex("#ffd98a"));
  poly(
    [
      [511, 484],
      [520, 472],
      [529, 484],
    ],
    hex("#2c2140"),
    1,
  );
  glow(520, 490, 26, hex("#ffe9a8"), 0.7);

  // Waterfalls pouring off the cliff edge into the clouds.
  function waterfall(x: number, y0: number, y1: number, w: number): void {
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const sway = Math.sin(t0 * 5) * 4;
      line(
        x + sway,
        y0 + t0 * (y1 - y0),
        x + Math.sin(t1 * 5) * 4,
        y0 + t1 * (y1 - y0),
        w * (1 - t0 * 0.3),
        hex("#dff1fb"),
        0.9 - t0 * 0.35,
      );
    }
  }
  waterfall(398, 612, 796, 9);
  waterfall(556, 616, 800, 8);
  // Foam where the falls meet the cloud sea.
  ellipse(398, 798, 26, 10, hex("#ffffff"), 0.75);
  ellipse(556, 802, 22, 9, hex("#ffffff"), 0.75);
  // Mist hugging the cliff base.
  ellipse(470, 788, 90, 16, hex("#f6e7d2"), 0.5);
})();

// 9. Sea of clouds: warm deck at the bottom, puffs above it.
vgrad(780, 1024, [
  [0.0, hex("#f3e2cb")],
  [0.55, hex("#e5c9cf")],
  [1.0, hex("#c39ec9")],
]);
const CLOUDS: Array<[number, number, number, number, string, number]> = [
  [120, 830, 150, 34, "#f8ecd8", 0.95],
  [330, 856, 170, 40, "#f3e2cb", 0.95],
  [560, 842, 180, 38, "#f8ecd8", 0.95],
  [700, 880, 150, 36, "#eec9b8", 0.9],
  [60, 900, 160, 40, "#eec9b8", 0.9],
  [260, 920, 190, 42, "#f8ecd8", 0.95],
  [520, 930, 180, 40, "#e5c9cf", 0.9],
  [700, 950, 170, 44, "#f8ecd8", 0.95],
  [100, 980, 180, 42, "#f3e2cb", 0.95],
  [400, 985, 200, 44, "#eec9b8", 0.9],
  [640, 995, 190, 42, "#f8ecd8", 0.95],
  [210, 786, 120, 22, "#f8ecd8", 0.7],
  [600, 782, 130, 22, "#f8ecd8", 0.7],
  [90, 762, 90, 16, "#f6e7d2", 0.55],
  [690, 758, 90, 16, "#f6e7d2", 0.55],
];
for (const [cx, cy, rx, ry, col, a] of CLOUDS) {
  ellipse(cx, cy, rx, ry, hex(col), a, 0.3);
}
// Soft shadows under the cloud puffs, so the deck reads as layered, not flat.
ellipse(330, 872, 150, 16, hex("#b99cc4"), 0.25);
ellipse(560, 858, 160, 16, hex("#b99cc4"), 0.25);
ellipse(180, 900, 130, 14, hex("#a985b8"), 0.3);
ellipse(470, 940, 150, 15, hex("#a985b8"), 0.3);
ellipse(660, 1000, 150, 16, hex("#a985b8"), 0.3);
ellipse(120, 1005, 140, 15, hex("#a985b8"), 0.3);
// A few warmer, deeper puffs for contrast in the lower deck.
ellipse(430, 905, 90, 20, hex("#e0a894"), 0.55);
ellipse(90, 845, 80, 18, hex("#e0a894"), 0.5);
ellipse(690, 905, 85, 18, hex("#e0a894"), 0.5);

// ---------- hand-lettered display face (geometric caps, 100x140 box) ----------
// Each glyph is a list of polylines; rendered as thick round-capped strokes.
type Pt = [number, number];
const FONT: Record<string, Pt[][]> = {
  A: [[[50, 4], [8, 136]], [[50, 4], [92, 136]], [[29, 90], [71, 90]]],
  D: [[[12, 4], [12, 136]], [[12, 4], [56, 4], [80, 12], [90, 36], [90, 100], [80, 124], [56, 136], [12, 136]]],
  E: [[[12, 4], [12, 136]], [[12, 4], [86, 4]], [[12, 70], [68, 70]], [[12, 136], [86, 136]]],
  F: [[[12, 4], [12, 136]], [[12, 4], [86, 4]], [[12, 70], [68, 70]]],
  G: [[[84, 14], [58, 4], [30, 10], [14, 36], [14, 100], [30, 126], [58, 136], [84, 126], [92, 102]], [[92, 102], [56, 102], [56, 76], [80, 76]]],
  H: [[[12, 4], [12, 136]], [[88, 4], [88, 136]], [[12, 70], [88, 70]]],
  I: [[[50, 4], [50, 136]], [[28, 4], [72, 4]], [[28, 136], [72, 136]]],
  K: [[[12, 4], [12, 136]], [[14, 72], [86, 4]], [[30, 58], [86, 136]]],
  L: [[[12, 4], [12, 136]], [[12, 136], [86, 136]]],
  M: [[[8, 136], [8, 4], [50, 88], [92, 4], [92, 136]]],
  N: [[[8, 136], [8, 4], [92, 136], [92, 4]]],
  O: [[[50, 4], [74, 10], [88, 32], [88, 104], [74, 130], [50, 136], [26, 130], [12, 104], [12, 32], [26, 10], [50, 4]]],
  P: [[[12, 4], [12, 136]], [[12, 4], [58, 4], [82, 14], [88, 38], [82, 62], [58, 72], [12, 72]]],
  R: [[[12, 4], [12, 136]], [[12, 4], [58, 4], [82, 14], [88, 38], [82, 62], [58, 72], [12, 72]], [[56, 68], [88, 136]]],
  S: [[[82, 14], [58, 4], [32, 8], [16, 28], [16, 56], [32, 74], [58, 82], [80, 90], [86, 110], [72, 132], [46, 136], [22, 130]]],
  T: [[[8, 4], [92, 4]], [[50, 4], [50, 136]]],
  V: [[[8, 4], [50, 136], [92, 4]]],
  W: [[[6, 4], [22, 136], [50, 52], [78, 136], [94, 4]]],
  Y: [[[8, 4], [50, 76], [92, 4]], [[50, 76], [50, 136]]],
  "-": [[[18, 70], [82, 70]]],
};

// Draw centered text; returns its width. `capH` is the cap height in px.
function drawText(
  s: string,
  cx: number,
  yTop: number,
  capH: number,
  c: RGB,
  tracking: number,
  weight: number,
  shadow?: { dx: number; dy: number; c: RGB; a: number },
): number {
  const scale = capH / 140;
  const adv = (ch: string): number => (ch === " " ? 55 : 100) * scale + tracking;
  let total = 0;
  for (const ch of s) total += adv(ch);
  total -= tracking;
  const x0 = cx - total / 2;
  const render = (ox: number, oy: number, col: RGB, alpha: number): void => {
    let px = x0 + ox;
    for (const ch of s) {
      if (ch === " ") {
        px += adv(ch);
        continue;
      }
      if (ch === ".") {
        disc(px + 27 * scale, yTop + oy + 130 * scale, 4.5 * scale, col, alpha, 0.5);
        px += adv(ch);
        continue;
      }
      const glyph = FONT[ch];
      if (glyph) {
        for (const stroke of glyph) {
          for (let i = 0; i + 1 < stroke.length; i++) {
            const [ax, ay] = stroke[i];
            const [bx, by] = stroke[i + 1];
            line(
              px + ax * scale,
              yTop + oy + ay * scale,
              px + bx * scale,
              yTop + oy + by * scale,
              weight,
              col,
              alpha,
            );
          }
        }
      }
      px += adv(ch);
    }
  };
  if (shadow) render(shadow.dx, shadow.dy, shadow.c, shadow.a);
  render(0, 0, c, 1);
  return total;
}

// 10. The place's name, set into the picture with intent.
drawText("VELMARA", W / 2, 62, 104, IVORY, 9, 18, {
  dx: 0,
  dy: 6,
  c: hex("#1c1533"),
  a: 0.5,
});

// 11. Subtitle with flanking rules: the Floating Isles.
const subW = drawText("THE FLOATING ISLES", W / 2, 196, 30, GOLD, 10, 5.5, {
  dx: 0,
  dy: 2,
  c: hex("#1c1533"),
  a: 0.45,
});
line(48, 212, W / 2 - subW / 2 - 26, 212, 2, GOLD, 0.8);
line(W / 2 + subW / 2 + 26, 212, W - 48, 212, 2, GOLD, 0.8);

// 12. Tagline over the cloud sea: the promise of the stay.
const tagW = drawText(
  "WHERE THE SKY KEEPS ITS ISLANDS",
  W / 2,
  946,
  24,
  PLUM,
  3,
  4.5,
);
const dia = (cx: number, cy: number, r: number, c: RGB, a: number): void =>
  poly(
    [
      [cx, cy - r],
      [cx + r, cy],
      [cx, cy + r],
      [cx - r, cy],
    ],
    c,
    a,
  );
dia(W / 2 - tagW / 2 - 30, 958, 6, PLUM, 0.85);
dia(W / 2 + tagW / 2 + 30, 958, 6, PLUM, 0.85);

// Thin ivory frame, inset like a vintage poster border.
line(18, 18, W - 18, 18, 3, IVORY, 0.85);
line(18, H - 18, W - 18, H - 18, 3, IVORY, 0.85);
line(18, 18, 18, H - 18, 3, IVORY, 0.85);
line(W - 18, 18, W - 18, H - 18, 3, IVORY, 0.85);

// ---------- PNG encoder (RGB8, per-row filter choice, zlib level 9) ----------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePNG(): Buffer {
  const stride = W * 3;
  const raw = new Uint8Array(H * (1 + stride));
  const prev = new Uint8Array(stride);
  for (let y = 0; y < H; y++) {
    const row = buf.subarray(y * stride, (y + 1) * stride);
    // Score each filter by the sum of absolute values of signed bytes.
    let bestType = 0;
    let bestScore = Infinity;
    let best: Uint8Array | null = null;
    for (let f = 0; f <= 4; f++) {
      if (f === 3) continue; // Avg: rarely wins here, skip for speed.
      const filtered = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        let v: number;
        if (f === 0) v = row[i];
        else if (f === 1) v = row[i] - (i >= 3 ? row[i - 3] : 0);
        else if (f === 2) v = row[i] - prev[i];
        else {
          const a = i >= 3 ? row[i - 3] : 0;
          const b = prev[i];
          const c = i >= 3 ? prev[i - 3] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = row[i] - pr;
        }
        const byte = v & 0xff;
        filtered[i] = byte;
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = f;
        best = filtered;
      }
    }
    raw[y * (1 + stride)] = bestType;
    raw.set(best!, y * (1 + stride) + 1);
    prev.set(row);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(idat)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

mkdirSync("/output", { recursive: true });
const png = encodePNG();
writeFileSync(OUT, png);
console.log(`wrote ${OUT}: ${W}x${H}, ${png.length} bytes`);
