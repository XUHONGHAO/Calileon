// "Calileon" wordmark outlines, shaped with HarfBuzz from the bundled Nunito
// (static weight), so the logo never depends on a web font being loaded.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const NUNITO_LATIN = path.join(
  ROOT,
  "packages/excalidraw/fonts/Nunito/Nunito-Regular-XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2",
);

/** Extra spacing between letters (font units) to make room for emboldening. */
const TRACKING = 22;
/** Stroke width (font units) used to embolden the regular outlines. */
export const WORDMARK_EMBOLDEN = 34;

const fmt = (v) => (Math.round(v * 10) / 10).toString();

export const buildWordmark = async (text = "Calileon") => {
  const { woff2 } = require("fonteditor-core");
  await woff2.init();
  const ttf = Buffer.from(woff2.decode(fs.readFileSync(NUNITO_LATIN)));
  const hb = await require("harfbuzzjs");
  const face = hb.createFace(hb.createBlob(ttf), 0);
  const font = hb.createFont(face);
  const buf = hb.createBuffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(font, buf);

  let penX = 0;
  let d = "";
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const g of buf.json()) {
    const raw = font.glyphToPath(g.g);
    // HarfBuzz paths are y-up; flip to SVG y-down while offsetting by the pen
    let i = 0;
    let pendingX = 0;
    d += raw.replace(/-?\d+(\.\d+)?/g, (num) => {
      const v = parseFloat(num);
      if (i++ % 2 === 0) {
        pendingX = v + penX + g.dx;
        minX = Math.min(minX, pendingX);
        maxX = Math.max(maxX, pendingX);
        return fmt(pendingX);
      }
      const y = -(v + g.dy);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return fmt(y);
    });
    penX += g.ax + TRACKING;
  }
  buf.destroy();
  font.destroy();
  face.destroy();

  // pad the box by half the embolden stroke so nothing is clipped
  const pad = WORDMARK_EMBOLDEN / 2;
  return {
    d,
    box: {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + 2 * pad,
      h: maxY - minY + 2 * pad,
    },
  };
};
