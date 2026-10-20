// Build the Calileon logo set.
//
//   node scripts/brand/build.mjs
//
// Writes the SVG masters to brand/, the favicon/PWA/OG raster set to public/,
// and the path data used by the in-app <ExcalidrawLogo /> component.
// Rasterizing needs a local Chrome or Edge (override with CHROME_PATH).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import prettier from "prettier";

import { buildMark } from "./mark.mjs";
import { renderPng } from "./render.mjs";
import { buildWordmark, WORDMARK_EMBOLDEN } from "./wordmark.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BRAND = path.join(ROOT, "brand");
const PUBLIC = path.join(ROOT, "public");
const TS_OUT = path.join(
  ROOT,
  "packages/excalidraw/components/calileonLogoPaths.ts",
);

export const PALETTE = {
  gold: "#F7B733",
  flame: "#E8432E",
  crimson: "#B3122E",
  ember: "#2A0A12",
  ink: "#2A1418",
  inkOnDark: "#FFF1E6",
  cream: "#FFF6EC",
  night: "#1A1012",
};

// on dark surfaces the tail ends in crimson rather than near-black ember
const TAIL_ON_DARK = "#8E0F28";

const fmt = (v) => (Math.round(v * 100) / 100).toString();

const mark = buildMark();
const word = await buildWordmark();

const gradient = (id, tail = PALETTE.ember) =>
  `<linearGradient id="${id}" x1="420" y1="70" x2="120" y2="470" gradientUnits="userSpaceOnUse">` +
  `<stop offset="0" stop-color="${PALETTE.gold}"/>` +
  `<stop offset=".3" stop-color="${PALETTE.flame}"/>` +
  `<stop offset=".68" stop-color="${PALETTE.crimson}"/>` +
  `<stop offset="1" stop-color="${tail}" class="calileon-tail"/></linearGradient>`;

/** Mark contents in its 512 box. `fill` overrides the gradient (mono). */
const markBody = ({ fill = "url(#calileon-g)", eye = "#fff", pupil } = {}) => {
  const e = mark.eye;
  const parts = [`<path d="${mark.body}" fill="${fill}"/>`];
  // mono marks punch the eye out instead of painting it white
  parts.push(
    `<circle cx="${fmt(e.x)}" cy="${fmt(e.y)}" r="${fmt(e.r)}" fill="${eye}"/>`,
  );
  parts.push(
    `<circle cx="${fmt(e.x)}" cy="${fmt(e.y)}" r="${fmt(e.pupil)}" fill="${
      pupil ?? PALETTE.ember
    }"/>`,
  );
  return parts.join("");
};

const svg = (w, h, inner, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(
    h,
  )}" width="${fmt(w)}" height="${fmt(h)}">` +
  (defs ? `<defs>${defs}</defs>` : "") +
  inner +
  `</svg>\n`;

const wordPath = (color) =>
  `<path d="${word.d}" fill="${color}" stroke="${color}" stroke-width="${WORDMARK_EMBOLDEN}" stroke-linejoin="round"/>`;

// ---------------------------------------------------------------------------
// SVG masters

/** Symbol only, transparent background. */
const markSvg = (opts) =>
  svg(512, 512, markBody(opts), opts?.fill ? "" : gradient("calileon-g"));

/** Mark inside a rounded app tile (`radius` as a fraction of size). */
const tileSvg = ({
  bg = PALETTE.cream,
  scale = 0.78,
  radius = 0.22,
  tail = PALETTE.ember,
} = {}) => {
  const off = (512 * (1 - scale)) / 2;
  const r = 512 * radius;
  return svg(
    512,
    512,
    `<rect width="512" height="512" rx="${fmt(r)}" fill="${bg}"/>` +
      `<g transform="translate(${fmt(off)} ${fmt(
        off,
      )}) scale(${scale})">${markBody()}</g>`,
    gradient("calileon-g", tail),
  );
};

/** Horizontal lockup: mark + wordmark. */
const lockup = (inkColor, tail = PALETTE.ember) => {
  const markH = 512;
  // wordmark x-height-ish block at ~46% of the mark height
  const s = (markH * 0.46) / word.box.h;
  const gap = 56;
  const wordW = word.box.w * s;
  const w = markH + gap + wordW;
  const ty = (markH - word.box.h * s) / 2 - word.box.y * s;
  const tx = markH + gap - word.box.x * s;
  return {
    w,
    h: markH,
    svg: svg(
      w,
      markH,
      markBody() +
        `<g transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(
          s,
        )})">${wordPath(inkColor)}</g>`,
      gradient("calileon-g", tail),
    ),
  };
};

/** Wordmark only. */
const wordmarkSvg = (inkColor) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(word.box.x)} ${fmt(
    word.box.y,
  )} ${fmt(word.box.w)} ${fmt(word.box.h)}">${wordPath(inkColor)}</svg>\n`;

fs.mkdirSync(BRAND, { recursive: true });
const write = (file, content) => {
  fs.writeFileSync(file, content);
  console.log("wrote", path.relative(ROOT, file));
};

const lockLight = lockup(PALETTE.ink);
const lockDark = lockup(PALETTE.inkOnDark, TAIL_ON_DARK);
const masters = {
  "calileon-mark.svg": markSvg(),
  "calileon-mark-mono-dark.svg": markSvg({
    fill: PALETTE.ink,
    eye: PALETTE.cream,
    pupil: PALETTE.ink,
  }),
  "calileon-mark-mono-light.svg": markSvg({
    fill: PALETTE.inkOnDark,
    eye: PALETTE.night,
    pupil: PALETTE.inkOnDark,
  }),
  "calileon-app-icon.svg": tileSvg(),
  "calileon-app-icon-dark.svg": tileSvg({
    bg: PALETTE.night,
    tail: TAIL_ON_DARK,
  }),
  "calileon-logo.svg": lockLight.svg,
  "calileon-logo-on-dark.svg": lockDark.svg,
  "calileon-wordmark.svg": wordmarkSvg(PALETTE.ink),
  "calileon-wordmark-on-dark.svg": wordmarkSvg(PALETTE.inkOnDark),
};
for (const [name, content] of Object.entries(masters)) {
  write(path.join(BRAND, name), content);
}
// ---------------------------------------------------------------------------
// favicon / PWA / OG raster set

/** Mark scaled so its bounding box fills `fill` of the canvas. */
const fittedMark = (fill) => {
  const s = (512 * fill) / mark.size;
  const off = 256 - 256 * s;
  return svg(
    512,
    512,
    `<g transform="translate(${fmt(off)} ${fmt(off)}) scale(${fmt(
      s,
    )})">${markBody()}</g>`,
    gradient("calileon-g"),
  );
};

// browsers display favicon.svg in the tab: keep it tight and transparent
// (dark browser chrome gets the crimson tail via prefers-color-scheme)
write(
  path.join(PUBLIC, "favicon.svg"),
  fittedMark(0.96).replace(
    "<defs>",
    `<style>@media (prefers-color-scheme:dark){.calileon-tail{stop-color:${TAIL_ON_DARK}}}</style><defs>`,
  ),
);

const png = (name, content, size, bg) => {
  renderPng(content, path.join(PUBLIC, name), size, size, bg);
  console.log("wrote", `public/${name}`);
};
png("favicon-16x16.png", fittedMark(1), 16);
png("favicon-32x32.png", fittedMark(0.98), 32);
// iOS rounds the corners itself and dislikes transparency: full-bleed tile
png("apple-touch-icon.png", tileSvg({ radius: 0, scale: 0.72 }), 180);
png("android-chrome-192x192.png", tileSvg(), 192);
png("android-chrome-512x512.png", tileSvg(), 512);
// maskable: full bleed, mark inside the 80% safe zone
png("maskable_icon_x192.png", tileSvg({ radius: 0, scale: 0.62 }), 192);
png("maskable_icon_x512.png", tileSvg({ radius: 0, scale: 0.62 }), 512);

// favicon.ico: PNG-compressed 16/32/48 frames
const icoFrames = [16, 32, 48].map((size) => {
  const file = path.join(BRAND, `.ico-${size}.png`);
  renderPng(fittedMark(size === 16 ? 1 : 0.98), file, size, size);
  const data = fs.readFileSync(file);
  fs.rmSync(file);
  return { size, data };
});
const header = Buffer.alloc(6 + 16 * icoFrames.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoFrames.length, 4);
let offset = header.length;
icoFrames.forEach(({ size, data }, i) => {
  const at = 6 + i * 16;
  header.writeUInt8(size, at);
  header.writeUInt8(size, at + 1);
  header.writeUInt8(0, at + 2);
  header.writeUInt8(0, at + 3);
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
write(
  path.join(PUBLIC, "favicon.ico"),
  Buffer.concat([header, ...icoFrames.map((f) => f.data)]),
);

// Open Graph / Twitter card: lockup centered on cream
{
  const W = 1200;
  const H = 675;
  const lw = 760;
  const s = lw / lockLight.w;
  const lh = lockLight.h * s;
  const og = svg(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="${PALETTE.cream}"/>` +
      `<g transform="translate(${fmt((W - lw) / 2)} ${fmt(
        (H - lh) / 2,
      )}) scale(${fmt(s)})">${lockLight.svg.replace(
        /^<svg[^>]*>|<\/svg>\n$/g,
        "",
      )}</g>`,
  );
  renderPng(og, path.join(PUBLIC, "og-image-3.png"), W, H);
  console.log("wrote public/og-image-3.png");
}

// ---------------------------------------------------------------------------
// path data for the in-app logo component

const lockupWordBox = word.box;
write(
  TS_OUT,
  `// Generated by scripts/brand/build.mjs — do not edit by hand.\n\n` +
    `export const CALILEON_MARK_PATH =\n  ${JSON.stringify(mark.body)};\n\n` +
    `export const CALILEON_MARK_VIEWBOX = ${JSON.stringify(
      [256 - mark.size / 2, 256 - mark.size / 2, mark.size, mark.size]
        .map((v) => fmt(v))
        .join(" "),
    )};\n\n` +
    `export const CALILEON_MARK_EYE = ${JSON.stringify({
      cx: +fmt(mark.eye.x),
      cy: +fmt(mark.eye.y),
      r: +fmt(mark.eye.r),
      pupil: +fmt(mark.eye.pupil),
    })};\n\n` +
    `export const CALILEON_GRADIENT = ${JSON.stringify([
      [0, PALETTE.gold],
      [0.3, PALETTE.flame],
      [0.68, PALETTE.crimson],
      [1, PALETTE.ember],
    ])} as const;\n\n` +
    `export const CALILEON_TAIL_ON_DARK = ${JSON.stringify(
      TAIL_ON_DARK,
    )};\n\n` +
    `export const CALILEON_WORDMARK_PATH =\n  ${JSON.stringify(word.d)};\n\n` +
    `export const CALILEON_WORDMARK_VIEWBOX = ${JSON.stringify(
      [lockupWordBox.x, lockupWordBox.y, lockupWordBox.w, lockupWordBox.h]
        .map((v) => fmt(v))
        .join(" "),
    )};\n\n` +
    `export const CALILEON_WORDMARK_EMBOLDEN = ${WORDMARK_EMBOLDEN};\n`,
);

// keep the generated module in the repo's Prettier style
const prettierOptions = (await prettier.resolveConfig(TS_OUT)) ?? {};
fs.writeFileSync(
  TS_OUT,
  prettier.format(fs.readFileSync(TS_OUT, "utf8"), {
    ...prettierOptions,
    filepath: TS_OUT,
  }),
);
