// Logo generator for Ren2Leaf: `node generate.mjs <outdir>` re-emits every mark.
// Geometry is computed here (tapered snake bodies, leaf lenses) so the SVGs are plain paths.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GLYPHS } from './glyphs.mjs';

const OUT = process.argv[2] || new URL('.', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const R = (n) => Math.round(n * 100) / 100;
const rad = (d) => (d * Math.PI) / 180;

/* ---------- vector + spline helpers ---------- */

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const perp = (a) => [-a[1], a[0]];

// Catmull-Rom through pts -> cubic bezier path.
function crPath(pts, close = false) {
    const p = pts.slice();
    if (close && len(sub(p[0], p[p.length - 1])) < 0.01) p.pop();
    const at = (i) => {
        if (close) return p[(i + p.length) % p.length];
        return p[Math.max(0, Math.min(p.length - 1, i))];
    };
    let d = `M ${R(p[0][0])} ${R(p[0][1])}`;
    const last = close ? p.length - 1 : p.length - 2;
    for (let i = 0; i <= last; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const c1 = add(p1, mul(sub(p2, p0), 1 / 6));
        const c2 = sub(p2, mul(sub(p3, p1), 1 / 6));
        d += ` C ${R(c1[0])} ${R(c1[1])} ${R(c2[0])} ${R(c2[1])} ${R(p2[0])} ${R(p2[1])}`;
    }
    return close ? d + ' Z' : d;
}

// Resample a polyline of key points into n points along a Catmull-Rom spline.
function spline(keys, n) {
    const at = (i) => keys[Math.max(0, Math.min(keys.length - 1, i))];
    const out = [];
    const segs = keys.length - 1;
    for (let s = 0; s < segs; s++) {
        const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
        const steps = Math.max(2, Math.round(n / segs));
        for (let k = 0; k < steps; k++) {
            const t = k / steps, t2 = t * t, t3 = t2 * t;
            out.push([
                0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
            ]);
        }
    }
    out.push(keys[keys.length - 1]);
    return out;
}

// Body outline: centre[0] is the HEAD end, centre[n-1] the tail tip.
function body(src, widthFn) {
    // Catmull-Rom keeps the outline smooth, so a modest point count is enough.
    const keep = 58;
    const centre = src.length <= keep ? src
        : Array.from({ length: keep }, (_, i) => src[Math.round((i * (src.length - 1)) / (keep - 1))]);
    const n = centre.length;
    const tan = centre.map((p, i) => unit(sub(centre[Math.min(n - 1, i + 1)], centre[Math.max(0, i - 1)])));
    const w = centre.map((_, i) => widthFn(i / (n - 1)));
    const left = centre.map((p, i) => add(p, mul(perp(tan[i]), w[i])));
    const right = centre.map((p, i) => sub(p, mul(perp(tan[i]), w[i])));
    // drop the head cap (a head shape is drawn over it) but round the tail
    const tailTip = add(centre[n - 1], mul(tan[n - 1], w[n - 1] * 0.9));
    return crPath([...left, tailTip, ...right.reverse()], true);
}

/* ---------- parts ---------- */

// Snake head, local frame: origin at the neck, +x forward, +y to the left.
function head({ at, dir, neck = 13, length = 40, gape = 1 }) {
    const a = Math.atan2(dir[1], dir[0]);
    const ca = Math.cos(a), sa = Math.sin(a);
    const T = ([x, y]) => [at[0] + x * ca - y * sa, at[1] + x * sa + y * ca];
    const L = length, h = neck;
    // blunt wedge: wide jaw hinge, rounded snout, short gape cut into the front
    const outline = [
        [0, h], [L * 0.36, h + 4.5], [L * 0.74, h + 1.6], [L * 0.94, h * 0.44],
        [L * 0.99, 3 * gape], [L * 0.7, 0.3 * gape],            // mouth corner
        [L * 0.97, -4.6 * gape], [L * 0.9, -h * 0.6], [L * 0.68, -h - 0.5], [L * 0.34, -h - 3], [0, -h],
    ].map(T);
    const d = crPath(outline, true);
    const eye = T([L * 0.6, h * 0.58]);
    const lipA = T([L * 0.97, 4.5 * gape]), lipB = T([L * 0.56, 0.6 * gape]), lipC = T([L, -6.5 * gape]);
    return { d, outline, eye, mouth: { lipA, lipB, lipC }, tip: T([L, 0]), T };
}

// Leaf, local frame: stem at origin, apex at (L, 0).
function leaf({ at, dir, L = 90, up = 0.38, down = 0.3, stem = 0 }) {
    const a = Math.atan2(dir[1], dir[0]);
    const ca = Math.cos(a), sa = Math.sin(a);
    const T = ([x, y]) => [at[0] + x * ca - y * sa, at[1] + x * sa + y * ca];
    const f = (p) => `${R(p[0])} ${R(p[1])}`;
    const blade = `M ${f(T([0, 0]))} C ${f(T([L * 0.16, -L * up * 0.9]))} ${f(T([L * 0.62, -L * up]))} ${f(T([L, 0]))}`
        + ` C ${f(T([L * 0.62, L * down]))} ${f(T([L * 0.16, L * down * 0.9]))} ${f(T([0, 0]))} Z`;
    const veins = [`M ${f(T([L * 0.04, 0]))} L ${f(T([L * 0.9, 0]))}`];
    for (const u of [0.24, 0.42, 0.6]) {
        veins.push(`M ${f(T([L * u, 0]))} L ${f(T([L * (u + 0.2), -L * up * 0.62]))}`);
        veins.push(`M ${f(T([L * (u + 0.06), 0]))} L ${f(T([L * (u + 0.24), L * down * 0.58]))}`);
    }
    const stemPath = stem
        ? `M ${f(T([0, 0]))} C ${f(T([-stem * 0.4, 1]))} ${f(T([-stem * 0.8, 4]))} ${f(T([-stem, 8]))}`
        : null;
    const cubic = (p0, c1, c2, p1) => Array.from({ length: 17 }, (_, i) => {
        const t = i / 16, u = 1 - t;
        return [
            u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
            u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
        ];
    });
    const hull = [
        ...cubic(T([0, 0]), T([L * 0.16, -L * up * 0.9]), T([L * 0.62, -L * up]), T([L, 0])),
        ...cubic(T([L, 0]), T([L * 0.62, L * down]), T([L * 0.16, L * down * 0.9]), T([0, 0])),
    ];
    return { blade, veins: veins.join(' '), stem: stemPath, hull };
}

/* ---------- shared svg scaffolding ---------- */

const defs = `
    <defs>
        <!-- Ren'Py accent (gui.accent_color #cc6600, hover #e0a366) -> NarraLeaf teal -->
        <linearGradient id="skin" x1="86%" y1="94%" x2="22%" y2="8%">
            <stop offset="0" stop-color="#a84d00"/>
            <stop offset=".55" stop-color="#cc6600"/>
            <stop offset="1" stop-color="#e3a86d"/>
        </linearGradient>
        <linearGradient id="skin-leaf" x1="18%" y1="92%" x2="80%" y2="8%">
            <stop offset="0" stop-color="#2f90ab"/>
            <stop offset="1" stop-color="#58c0ce"/>
        </linearGradient>
    </defs>`;

function svg(inner, { title, extraDefs = '' } = {}) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="${title}">
    <title>${title}</title>${defs}${extraDefs}
${inner}
</svg>
`;
}


/* ---------- the mark: a snake shaped as a "2", eating a leaf ---------- */

const KEYS = [[54, 74], [70, 54], [100, 40], [137, 44], [160, 68], [156, 98],
    [128, 128], [96, 158], [74, 186], [68, 206], [112, 208], [158, 208], [198, 207]];

const rot = (v, deg) => {
    const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};

const boxOf = (pts) => pts.reduce((b, p) => ({
    x1: Math.min(b.x1, p[0]), y1: Math.min(b.y1, p[1]),
    x2: Math.max(b.x2, p[0]), y2: Math.max(b.y2, p[1]),
}), { x1: 1e9, y1: 1e9, x2: -1e9, y2: -1e9 });

// The mark, before it is placed: paths plus the boxes the lockup needs.
function buildMark({ leafL = 86, leafTilt = 8 } = {}) {
    const centre = spline(KEYS, 160);
    const w = (t) => 13.4 * Math.pow(1 - t, 0.5) + 1.5;
    const bodyD = body(centre, w);
    const fwd = unit(sub(centre[0], centre[4]));
    const H = head({ at: centre[0], dir: fwd, neck: 13.6, length: 40, gape: 0.95 });
    const mouth = add(centre[0], mul(fwd, 31));
    const lf = leaf({ at: mouth, dir: rot(fwd, leafTilt), L: leafL, up: 0.4, down: 0.3 });

    // boxes: the digit alone (what sits on the baseline) and the whole mark
    const N = centre.length;
    const tan = centre.map((p, i) => unit(sub(centre[Math.min(N - 1, i + 1)], centre[Math.max(0, i - 1)])));
    const rim = centre.flatMap((p, i) => {
        const o = mul(perp(tan[i]), w(i / (N - 1)));
        return [add(p, o), sub(p, o)];
    });
    const digit = boxOf([...rim, ...H.outline]);
    const full = boxOf([...rim, ...H.outline, ...lf.hull]);
    return { bodyD, H, lf, digit, full };
}

const PARTS = (m, { mono = false } = {}) => mono
    ? `    <path d="${m.lf.blade}" fill="currentColor" fill-opacity=".55"/>
    <path d="${m.bodyD}" fill="currentColor"/>
    <path d="${m.H.d}" fill="currentColor"/>
    <circle cx="${R(m.H.eye[0])}" cy="${R(m.H.eye[1])}" r="3.6" fill="#fff" fill-opacity=".9"/>`
    : `    <path d="${m.lf.blade}" fill="#40a8c4"/>
    <path d="${m.lf.veins}" fill="none" stroke="#0b2b33" stroke-opacity=".34" stroke-width="2.4" stroke-linecap="round"/>
    <path d="${m.bodyD}" fill="url(#skin)"/>
    <path d="${m.H.d}" fill="#cc6600"/>
    <circle cx="${R(m.H.eye[0])}" cy="${R(m.H.eye[1])}" r="3.6" fill="#2a1403"/>`;

// Square icon: the mark centred in a 256 box with even padding.
function markSvg(m, { mono = false } = {}) {
    const pad = 18;
    const { x1, y1, x2, y2 } = m.full;
    const k = Math.min((256 - pad * 2) / (x2 - x1), (256 - pad * 2) / (y2 - y1));
    const tx = (256 - (x2 - x1) * k) / 2 - x1 * k;
    const ty = (256 - (y2 - y1) * k) / 2 - y1 * k;
    const g = `    <g transform="translate(${R(tx)} ${R(ty)}) scale(${R(k)})">
${PARTS(m, { mono })}
    </g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Ren2Leaf">
    <title>Ren2Leaf</title>${mono ? '' : defs}
${g}
</svg>
`;
}

/* ---------- the lockup: Ren + the mark as the "2" + Leaf ---------- */

function lockup(m, weight = 'regular') {
    const G = GLYPHS[weight], cap = G.cap;
    const k = cap / (m.digit.y2 - m.digit.y1);          // digit height == cap height
    const over = (m.digit.x1 - m.full.x1) * k;          // how far the leaf reaches past the digit
    const gapBefore = Math.max(over + 9, 14);
    const gapAfter = 16;
    const markX = G.ren.adv + gapBefore - m.digit.x1 * k;
    const markY = -m.digit.y2 * k;                      // digit sits on the baseline
    const leafX = G.ren.adv + gapBefore + (m.digit.x2 - m.digit.x1) * k + gapAfter;
    const top = Math.min(-cap, (m.full.y1 - m.digit.y2) * k);
    const right = leafX + G.leaf.adv;
    const pad = 10;
    const vb = [-pad, top - pad, right + pad * 2, -top + pad * 2];
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.map(R).join(' ')}" width="${R(vb[2])}" height="${R(vb[3])}" role="img" aria-label="Ren2Leaf">
    <title>Ren2Leaf</title>${defs}
    <style>
        /* Override by setting .r2l-word { fill: ... } where the lockup is used. */
        .r2l-word { fill: #eef1f5; }
        @media (prefers-color-scheme: light) { .r2l-word { fill: #1b2129; } }
    </style>
    <g class="r2l-word">
        <path d="${G.ren.d}"/>
        <path d="${G.leaf.d}" transform="translate(${R(leafX)} 0)"/>
    </g>
    <g transform="translate(${R(markX)} ${R(markY)}) scale(${R(k)})">
${PARTS(m)}
    </g>
</svg>
`;
}

const mark = buildMark();
const files = {
    'ren2leaf-mark.svg': markSvg(mark),
    'ren2leaf-mark-mono.svg': markSvg(mark, { mono: true }),
    'ren2leaf-lockup.svg': lockup(mark, 'light'),
    'ren2leaf-lockup-regular.svg': lockup(mark, 'regular'),
};
for (const [k, v] of Object.entries(files)) writeFileSync(join(OUT, k), v);

const sheet = `<!doctype html><meta charset="utf-8"><title>Ren2Leaf logo</title>
<style>
  body{margin:0;font:300 14px/1.5 ui-sans-serif,system-ui,sans-serif;background:#05060a;color:#eef1f5}
  h2{font-weight:500;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9aa3ae;margin:24px 20px 8px}
  .band{padding:18px 20px;display:flex;flex-wrap:wrap;align-items:flex-end;gap:28px}
  .light{background:#eef0f4;color:#1b2129}
  .light .r2l-word{fill:#1b2129}
  .m256 svg{width:180px;height:180px}.m64 svg{width:64px;height:64px}.m32 svg{width:32px;height:32px}.m20 svg{width:20px;height:20px}
  .lk svg{height:56px;width:auto}.lk-s svg{height:24px;width:auto}
  .mono{color:#eef1f5}.light .mono{color:#1b2129}
</style>
<h2>mark</h2>
<div class="band"><span class="m256">${files['ren2leaf-mark.svg']}</span><span class="m64">${files['ren2leaf-mark.svg']}</span>
<span class="m32">${files['ren2leaf-mark.svg']}</span><span class="m20">${files['ren2leaf-mark.svg']}</span>
<span class="m64 mono">${files['ren2leaf-mark-mono.svg']}</span><span class="m32 mono">${files['ren2leaf-mark-mono.svg']}</span></div>
<h2>lockup — regular / light</h2>
<div class="band"><span class="lk">${files['ren2leaf-lockup.svg']}</span><span class="lk-s">${files['ren2leaf-lockup.svg']}</span></div>
<div class="band"><span class="lk">${files['ren2leaf-lockup-regular.svg']}</span><span class="lk-s">${files['ren2leaf-lockup-regular.svg']}</span></div>
<h2>light background</h2>
<div class="band light"><span class="m256">${files['ren2leaf-mark.svg']}</span><span class="m64">${files['ren2leaf-mark.svg']}</span>
<span class="m32 mono">${files['ren2leaf-mark-mono.svg']}</span><span class="lk">${files['ren2leaf-lockup.svg']}</span></div>
<div class="band light"><span class="lk">${files['ren2leaf-lockup-regular.svg']}</span><span class="lk-s">${files['ren2leaf-lockup-regular.svg']}</span></div>
`;
// The contact sheet is only for comparing drafts, so it stays out of the repo copy.
if (process.argv[2]) writeFileSync(join(OUT, 'preview.html'), sheet);
console.log(`wrote ${Object.keys(files).length} files to ${OUT}`);
