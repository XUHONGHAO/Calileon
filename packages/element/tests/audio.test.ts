import { pointFrom, type GlobalPoint } from "@excalidraw/math";
import {
  AUDIO_ELEMENT_HEIGHT,
  AUDIO_ELEMENT_MAX_WIDTH,
  AUDIO_ELEMENT_MIN_WIDTH,
  AUDIO_AVATAR_RING_COLOR,
  AUDIO_PEAKS_COUNT,
  arrayToMap,
} from "@excalidraw/common";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  formatAudioDuration,
  getAudioElementWidth,
  getDefaultAudioAvatar,
  isValidAudioAvatarGlyph,
  normalizeAudioPeaks,
  restoreAudioFields,
} from "../src/audio/helpers";
import {
  getAudioAvatarDrawOps,
  getAudioContentDrawOps,
  getAudioElementLayout,
  getAudioHitTarget,
  getAudioPlaybackDrawOps,
} from "../src/audio/render";
import { getElementBounds } from "../src/bounds";
import { hitElementItself } from "../src/collision";
import { distanceToElement } from "../src/distance";
import { getTransformHandles } from "../src/transformHandles";
import {
  isFileBackedElement,
  isInitializedFileBackedElement,
} from "../src/typeChecks";

import type { ExcalidrawAudioElement } from "../src/types";

const audio = (opts: Partial<Parameters<typeof API.createElement>[0]> = {}) =>
  API.createElement({
    type: "audio",
    x: 100,
    y: 100,
    fileId: "voice-1",
    duration: 5000,
    ...opts,
  } as any) as unknown as ExcalidrawAudioElement;

describe("audio element helpers (ADR 0034)", () => {
  it("derives width linearly from duration and clamps the ends", () => {
    expect(getAudioElementWidth(0)).toBe(AUDIO_ELEMENT_MIN_WIDTH);
    expect(getAudioElementWidth(1000)).toBe(AUDIO_ELEMENT_MIN_WIDTH);
    expect(getAudioElementWidth(60_000)).toBe(AUDIO_ELEMENT_MAX_WIDTH);
    // generated audio longer than a recording stays at the max width
    expect(getAudioElementWidth(5 * 60_000)).toBe(AUDIO_ELEMENT_MAX_WIDTH);
    const mid = getAudioElementWidth(30_500);
    expect(mid).toBe(
      Math.round((AUDIO_ELEMENT_MIN_WIDTH + AUDIO_ELEMENT_MAX_WIDTH) / 2),
    );
  });

  it("formats durations like a chat voice message", () => {
    expect(formatAudioDuration(200)).toBe("1″");
    expect(formatAudioDuration(12_400)).toBe("12″");
    expect(formatAudioDuration(60_000)).toBe("1′00″");
    expect(formatAudioDuration(65_000)).toBe("1′05″");
  });

  it("normalizes peaks to a fixed count in 0..1", () => {
    const peaks = normalizeAudioPeaks([0.5, -2, Number.NaN, "x", 0.333]);
    expect(peaks).toHaveLength(AUDIO_PEAKS_COUNT);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
    expect(peaks.every((peak) => Number.isInteger(peak * 100))).toBe(true);
    expect(normalizeAudioPeaks(null)).toEqual(
      new Array(AUDIO_PEAKS_COUNT).fill(0),
    );
    // downsampling keeps the max of each bucket
    const long = Array.from({ length: AUDIO_PEAKS_COUNT * 4 }, (_, i) =>
      i % 4 === 3 ? 0.9 : 0.1,
    );
    expect(new Set(normalizeAudioPeaks(long))).toEqual(new Set([0.9]));
  });

  it("accepts one CJK ideograph or one uppercase letter as avatar glyph", () => {
    expect(isValidAudioAvatarGlyph("文")).toBe(true);
    expect(isValidAudioAvatarGlyph("A")).toBe(true);
    expect(isValidAudioAvatarGlyph("a")).toBe(false);
    expect(isValidAudioAvatarGlyph("AB")).toBe(false);
    expect(isValidAudioAvatarGlyph("文字")).toBe(false);
    expect(isValidAudioAvatarGlyph("😀")).toBe(false);
    expect(getDefaultAudioAvatar("alice").glyph).toBe("A");
    expect(getDefaultAudioAvatar("王五").glyph).toBe("王");
    expect(getDefaultAudioAvatar(null).glyph).toBe("?");
    expect(getDefaultAudioAvatar("alice")).toEqual(
      getDefaultAudioAvatar("alice"),
    );
  });
});

describe("restoreAudioFields", () => {
  const base = {
    source: "recording",
    duration: 8000,
    peaks: [0.2, 0.4],
    width: 250,
    height: 999,
    angle: 1.2,
  };

  it("drops elements with an unknown source instead of rewriting it", () => {
    expect(restoreAudioFields({ ...base, source: "upload" })).toBeNull();
    expect(restoreAudioFields({ ...base, source: undefined })).toBeNull();
  });

  it("clamps geometry and never recomputes width from duration", () => {
    const restored = restoreAudioFields(base)!;
    // 250 is not what getAudioElementWidth(8000) would produce
    expect(restored.width).toBe(250);
    expect(restored.height).toBe(AUDIO_ELEMENT_HEIGHT);
    expect(restored.angle).toBe(0);
    expect(restoreAudioFields({ ...base, width: 5 })!.width).toBe(
      AUDIO_ELEMENT_MIN_WIDTH,
    );
    expect(restoreAudioFields({ ...base, width: 9999 })!.width).toBe(
      AUDIO_ELEMENT_MAX_WIDTH,
    );
    expect(restoreAudioFields({ ...base, width: "x" })!.width).toBe(
      AUDIO_ELEMENT_MIN_WIDTH,
    );
  });

  it("caps recordings at 60s but not generated audio", () => {
    expect(restoreAudioFields({ ...base, duration: 90_000 })!.duration).toBe(
      60_000,
    );
    expect(
      restoreAudioFields({ ...base, source: "generated", duration: 90_000 })!
        .duration,
    ).toBe(90_000);
    expect(restoreAudioFields({ ...base, duration: -1 })!.duration).toBe(1000);
  });

  it("rejects malformed transcript and author data", () => {
    const restored = restoreAudioFields({
      ...base,
      transcript: { text: "你好", lang: "zh-CN", mode: "cloud" },
      author: {
        name: "Ann",
        avatar: { color: "#ff0000", glyph: "A" },
        id: "x",
      },
    })!;
    expect(restored.transcript).toBeNull();
    // invalid avatar falls back to null, account ids are not kept
    expect(restored.author).toEqual({ name: "Ann", avatar: null });

    const valid = restoreAudioFields({
      ...base,
      transcript: { text: "你好", lang: "zh-CN", mode: "local-only" },
      author: { name: "Ann", avatar: { color: "#1f9e8f", glyph: "文" } },
    })!;
    expect(valid.transcript).toEqual({
      text: "你好",
      lang: "zh-CN",
      mode: "local-only",
    });
    expect(valid.author?.avatar).toEqual({ color: "#1f9e8f", glyph: "文" });
  });
});

describe("audio element geometry", () => {
  it("creates a fixed-height bubble whose width follows duration", () => {
    const element = audio({ duration: 60_000 });
    expect(element.width).toBe(AUDIO_ELEMENT_MAX_WIDTH);
    expect(element.height).toBe(AUDIO_ELEMENT_HEIGHT);
    expect(element.angle).toBe(0);
    expect(isFileBackedElement(element)).toBe(true);
    expect(isInitializedFileBackedElement(element)).toBe(true);
  });

  it("has rectangle bounds, distance and hit testing", () => {
    const element = audio();
    const elementsMap = arrayToMap([element]);
    expect(getElementBounds(element, elementsMap)).toEqual([
      100,
      100,
      100 + element.width,
      100 + AUDIO_ELEMENT_HEIGHT,
    ]);
    const inside = pointFrom<GlobalPoint>(100 + element.width / 2, 124);
    // distance is to the outline: the centre is half the height away
    expect(distanceToElement(element, elementsMap, inside)).toBeCloseTo(
      AUDIO_ELEMENT_HEIGHT / 2,
    );
    expect(
      distanceToElement(element, elementsMap, pointFrom<GlobalPoint>(90, 124)),
    ).toBeCloseTo(10);
    // the interior is draggable even with a transparent background
    expect(
      hitElementItself({
        point: inside,
        element: { ...element, backgroundColor: "transparent" },
        threshold: 1,
        elementsMap,
      }),
    ).toBe(true);
  });

  it("offers no resize or rotate handles", () => {
    const element = audio();
    expect(
      getTransformHandles(element, { value: 1 as any }, arrayToMap([element])),
    ).toEqual({});
  });

  it("lays out avatar, play zone, waveform and transcript badge", () => {
    const short = getAudioElementLayout(audio({ duration: 1000 }));
    const long = getAudioElementLayout(audio({ duration: 60_000 }));
    expect(short.bars.length).toBeGreaterThan(4);
    expect(long.bars.length).toBeGreaterThan(short.bars.length);
    expect(short.transcriptBadge).toBeNull();

    const withText = audio({
      duration: 1000,
      transcript: { text: "hi", lang: "en-US", mode: "auto" },
    });
    const layout = getAudioElementLayout(withText);
    expect(layout.transcriptBadge).not.toBeNull();
    expect(layout.bars.length).toBeGreaterThan(2);
    const last = layout.bars[layout.bars.length - 1];
    expect(last.x).toBeLessThan(layout.transcriptBadge!.cx);

    expect(getAudioHitTarget(withText, layout.play.cx, layout.cy)).toBe("play");
    expect(
      getAudioHitTarget(withText, layout.transcriptBadge!.cx, layout.cy),
    ).toBe("transcript");
    expect(getAudioHitTarget(withText, layout.avatar.cx, layout.cy)).toBeNull();
  });

  it("draws the avatar ring in the theme primary and dims unplayable audio", () => {
    const ops = getAudioContentDrawOps(audio(), "light");
    expect(ops[0]).toMatchObject({
      kind: "circle",
      fill: null,
      stroke: "#d2452a",
    });
    // the colored disc leaves a transparent gap inside the ring
    const [ring, disc] = ops as Extract<
      typeof ops[number],
      { kind: "circle" }
    >[];
    expect(disc).toMatchObject({ kind: "circle", stroke: null });
    expect(disc.r).toBeLessThan(ring.r - ring.strokeWidth / 2);
    expect(getAudioContentDrawOps(audio(), "dark")[0]).toMatchObject({
      stroke: "#ff8a5c",
    });
    const opacityOf = (element: ExcalidrawAudioElement) =>
      getAudioContentDrawOps(element, "light").find(
        (op) => op.kind === "rect",
      ) as { opacity: number };
    expect(opacityOf(audio()).opacity).toBeGreaterThan(
      opacityOf(audio({ status: "error" })).opacity,
    );
  });

  it("scales the avatar for the settings preview, keeping its proportions", () => {
    const avatar = { color: "#2f80ed", glyph: "山" };
    const at = (r: number) =>
      getAudioAvatarDrawOps(avatar, "dark", { cx: 0, cy: 0, r }) as any[];
    const [ring, disc, glyph] = at(30);
    expect(ring).toMatchObject({ r: 30, strokeWidth: 4, stroke: "#ff8a5c" });
    expect(disc).toMatchObject({ r: 24, fill: "#2f80ed" });
    expect(glyph).toMatchObject({ text: "山", fontSize: 30 });
    // the bubble draws the very same ops at r=15
    const bubble = audio({ author: { name: "Ann", avatar } });
    expect(getAudioContentDrawOps(bubble, "light").slice(0, 3)).toEqual(
      getAudioAvatarDrawOps(avatar, "light", {
        cx: 18,
        cy: AUDIO_ELEMENT_HEIGHT / 2,
        r: 15,
      }),
    );
  });

  it("draws playback progress as an overlay instead of a full redraw", () => {
    const element = audio({ duration: 30_000 });
    const { bars } = getAudioElementLayout(element);
    const ops = (progress: number, status: "playing" | "paused" = "playing") =>
      getAudioPlaybackDrawOps(element, "light", {
        status,
        progress,
        canvasBackgroundColor: "#ffffff",
      });
    const accentBars = (progress: number) =>
      ops(progress).filter(
        (op) => op.kind === "rect" && op.fill === AUDIO_AVATAR_RING_COLOR.light,
      );

    expect(accentBars(0)).toHaveLength(0);
    expect(accentBars(0.5)).toHaveLength(Math.round(bars.length / 2));
    expect(accentBars(1)).toHaveLength(bars.length);
    // the static play triangle is masked, then a pause or play glyph drawn
    expect(ops(0)[0]).toMatchObject({ kind: "circle", stroke: null });
    expect(ops(0).some((op) => op.kind === "path")).toBe(false);
    expect(ops(0.3, "paused").some((op) => op.kind === "path")).toBe(true);
    // a bubble without fill is masked with the canvas background
    const transparent = audio({ backgroundColor: "transparent" });
    expect(
      getAudioPlaybackDrawOps(transparent, "light", {
        status: "playing",
        progress: 0,
        canvasBackgroundColor: "#123456",
      })[0],
    ).toMatchObject({ fill: "#123456" });
  });
});
