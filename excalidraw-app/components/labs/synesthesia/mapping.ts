import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

import type { Features } from "./analysis";

export const MAX_ELEMENTS = 600;
export const MAX_DURATION = 300000;
export type Style = "lines" | "blocks" | "stars";
export type Area = { x: number; y: number; width: number; height: number };
export const createMapper = (
  seed: number,
  area: Area,
  style: Style,
  dark: boolean,
) => {
  let count = 0;
  let last = -Infinity;
  let previousStar: { x: number; y: number } | undefined;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  // Artwork pigments, not UI colors. Frozen per session and persisted on elements.
  const palette = dark
    ? ["#ff8a5c", "#ffd98a", "#e5739b", "#8e6870"]
    : ["#d2452a", "#8e0f28", "#1f7a70", "#6b4300"];
  return (
    f: Features,
    time: number,
    duration: number,
  ): ExcalidrawElementSkeleton[] => {
    if (
      time >= MAX_DURATION ||
      count >= MAX_ELEMENTS ||
      f.rms < 0.018 ||
      (!f.onset && time - last < 650)
    ) {
      return [];
    }
    last = time;
    const result: ExcalidrawElementSkeleton[] = [];
    const n = Math.min(f.onset ? 3 : 1, MAX_ELEMENTS - count);
    for (let i = 0; i < n; i++) {
      const bass = f.low >= f.high;
      const width =
        style === "stars"
          ? bass
            ? 10
            : 4
          : 4 + Math.min(1, f.low + f.rms) * 28;
      const height =
        style === "stars" ? width : 4 + Math.min(1, f.high + f.rms) * 35;
      const progress = Math.max(0, Math.min(1, time / duration));
      const direction = f.pitch
        ? Math.log2(f.pitch / 80) / 4
        : f.high / (f.low + f.mid + f.high || 1);
      const x =
        area.x + Math.min(area.width - width, progress * (area.width - width));
      const y =
        area.y +
        Math.max(
          0,
          Math.min(
            area.height - height,
            (1 - direction) * area.height * 0.7 + random() * area.height * 0.2,
          ),
        );
      const base = {
        x,
        y,
        width,
        height,
        seed: Math.floor(random() * 2147483647),
        strokeColor:
          palette[
            bass
              ? palette.length - 1
              : Math.floor(random() * (palette.length - 1))
          ],
        strokeWidth: 1 + f.low * 4,
        opacity: Math.round((bass ? 25 : 55) + f.rms * 35),
        roughness: 1.5,
      };
      if (style === "lines") {
        result.push({
          ...base,
          type: "line",
          points: [
            pointFrom(0, height),
            pointFrom(width * 0.3, f.onset ? 0 : height * 0.3),
            pointFrom(width * 0.65, height * 0.65),
            pointFrom(width, 0),
          ],
          roundness: f.onset ? null : { type: 2 },
        });
      } else {
        result.push({
          ...base,
          type: style === "blocks" ? "rectangle" : "ellipse",
          backgroundColor: base.strokeColor,
          fillStyle: "solid",
        });
        if (
          style === "stars" &&
          previousStar &&
          !bass &&
          count + n < MAX_ELEMENTS
        ) {
          result.push({
            ...base,
            type: "line",
            x: previousStar.x,
            y: previousStar.y,
            width: x - previousStar.x,
            height: y - previousStar.y,
            points: [
              pointFrom(0, 0),
              pointFrom(x - previousStar.x, y - previousStar.y),
            ],
            strokeWidth: 1,
          });
          count++;
        }
        if (style === "stars") {
          previousStar = { x, y };
        }
      }
      count++;
    }
    return result;
  };
};
