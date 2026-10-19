/**
 * Test helpers for Vault v2 (not imported by production code).
 */
import {
  newElement,
  newLinearElement,
  newTextElement,
} from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { LocalPoint } from "@excalidraw/math";

import { VaultSceneMaterializer } from "./materialize";
import { VaultSceneDoc } from "./sceneDoc";

export const withId = <T extends ExcalidrawElement>(
  element: T,
  id: string,
  index: string,
): T => ({ ...element, id, index, seed: id.length * 7919 } as T);

/** box-1 (rectangle) + bound label-1, free note-1, arrow-1 from box-1 to box-2 */
export const buildBasicScene = (label = "hello world") => {
  const box = withId(
    newElement({ type: "rectangle", x: 0, y: 0, width: 400, height: 80 }),
    "box-1",
    "a0",
  );
  const labelEl = withId(
    newTextElement({
      x: 10,
      y: 20,
      text: label,
      fontSize: 16,
      fontFamily: 1,
      containerId: box.id,
      textAlign: "center",
      verticalAlign: "middle",
    }),
    "label-1",
    "a1",
  );
  const note = withId(
    newTextElement({ x: 600, y: 0, text: "note", fontSize: 20, fontFamily: 1 }),
    "note-1",
    "a2",
  );
  const box2 = withId(
    newElement({ type: "ellipse", x: 800, y: 300, width: 200, height: 120 }),
    "box-2",
    "a3",
  );
  const arrow = withId(
    newLinearElement({
      type: "arrow",
      x: 400,
      y: 40,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(400, 300)],
    }),
    "arrow-1",
    "a4",
  );
  return [
    box,
    labelEl,
    note,
    box2,
    {
      ...arrow,
      startBinding: { elementId: box.id, fixedPoint: [1, 0.5], mode: "orbit" },
      endBinding: { elementId: box2.id, fixedPoint: [0, 0.5], mode: "orbit" },
    } as unknown as ExcalidrawElement,
  ];
};

export const replica = (actorId: string, from?: VaultSceneDoc) => {
  const scene = new VaultSceneDoc({ actorId });
  if (from) {
    scene.applyRemoteUpdate(from.encodeStateAsUpdate());
  }
  const materializer = new VaultSceneMaterializer(scene);
  return { scene, materializer };
};

export const seeded = (actorId = "actor-a", elements = buildBasicScene()) => {
  const r = replica(actorId);
  r.scene.transact(() => {
    for (const element of elements) {
      r.scene.createElement(element);
    }
  });
  return r;
};

/** bidirectional catch-up via state vectors */
export const sync = (a: VaultSceneDoc, b: VaultSceneDoc) => {
  const fromB = b.encodeStateAsUpdate(a.encodeStateVector());
  const fromA = a.encodeStateAsUpdate(b.encodeStateVector());
  a.applyRemoteUpdate(fromB);
  b.applyRemoteUpdate(fromA);
};

export const byId = (elements: readonly ExcalidrawElement[], id: string) =>
  elements.find((element) => element.id === id) as unknown as
    | Record<string, any>
    | undefined;

/** canonical JSON of a scene, version stamp excluded (stamps are local, R7) */
export const canonical = (elements: readonly ExcalidrawElement[]) =>
  JSON.stringify(
    elements.map((element) => {
      const { version, versionNonce, ...rest } = element as any;
      return Object.fromEntries(
        Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }),
  );

/** deterministic PRNG (mulberry32) */
export const prng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
