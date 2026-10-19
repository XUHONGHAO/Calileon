import { newElement, newTextElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { VaultSceneMaterializer } from "./materialize";
import { VaultSceneDoc } from "./sceneDoc";
import {
  buildBasicScene,
  byId,
  canonical,
  prng,
  replica,
  seeded,
  sync,
  withId,
} from "./testUtils";

/** n boxes with bound labels, free notes and arrows between neighbouring boxes */
const bigScene = (blocks: number): ExcalidrawElement[] => {
  const out: ExcalidrawElement[] = [];
  for (let i = 0; i < blocks; i++) {
    const n = (k: number) => `a${String(i * 4 + k).padStart(5, "0")}`;
    const box = withId(
      newElement({
        type: "rectangle",
        x: i * 300,
        y: 0,
        width: 260,
        height: 80,
      }),
      `box-${i}`,
      n(0),
    );
    const label = withId(
      newTextElement({
        x: 0,
        y: 0,
        text: `label ${i}`,
        fontSize: 16,
        fontFamily: 1,
        containerId: box.id,
      }),
      `label-${i}`,
      n(1),
    );
    const note = withId(
      newTextElement({
        x: i * 300,
        y: 200,
        text: `note ${i}`,
        fontSize: 20,
        fontFamily: 1,
      }),
      `note-${i}`,
      n(2),
    );
    out.push(box, label, note);
    if (i > 0) {
      const arrow = withId(
        newElement({ type: "rectangle", x: 0, y: 0, width: 1, height: 1 }),
        `arrow-${i}`,
        n(3),
      );
      out.push({
        ...arrow,
        type: "arrow",
        points: [
          [0, 0],
          [40, 0],
        ],
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
        startBinding: {
          elementId: `box-${i - 1}`,
          fixedPoint: [1, 0.5],
          mode: "orbit",
        },
        endBinding: {
          elementId: `box-${i}`,
          fixedPoint: [0, 0.5],
          mode: "orbit",
        },
      } as unknown as ExcalidrawElement);
    }
  }
  return out;
};

describe("VaultSceneMaterializer · incremental = full (W1 §5.1)", () => {
  it("fuzz: incremental output equals a fresh full materialization after every step", () => {
    let steps = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const random = prng(seed);
      const elements = bigScene(12);
      const ids = elements.map((element) => element.id);
      const a = seeded("actor-a", elements);
      const b = replica("actor-b", a.scene);
      a.materializer.materialize();
      const pick = (prefix?: string) => {
        const pool = prefix ? ids.filter((id) => id.startsWith(prefix)) : ids;
        return pool[Math.floor(random() * pool.length)];
      };
      for (let step = 0; step < 25; step++) {
        for (const r of random() < 0.3 ? [b, a] : [b]) {
          const roll = random();
          r.scene.transact(() => {
            if (roll < 0.2) {
              r.scene.writeFields(pick("box-"), {
                width: 80 + Math.floor(random() * 400),
              });
            } else if (roll < 0.45) {
              const id = random() < 0.5 ? pick("label-") : pick("note-");
              const text = r.scene.readText(id) ?? "";
              r.scene.editText(
                id,
                random() < 0.15 ? "" : `${text} more words here`,
              );
            } else if (roll < 0.55) {
              r.scene.deleteElement(pick());
            } else if (roll < 0.62) {
              const id = pick("label-");
              if (typeof r.scene.readWinner(id, "containerId") === "string") {
                r.scene.writeFields(id, {
                  containerId: null,
                  x: 5,
                  y: 5,
                  width: 100,
                  height: 20,
                });
              }
            } else if (roll < 0.75) {
              r.scene.writeFields(pick("arrow-"), {
                endBinding: {
                  elementId: pick("box-"),
                  fixedPoint: [0, 0.5],
                  mode: "orbit",
                },
              });
            } else {
              r.scene.writeFields(pick(), {
                x: Math.floor(random() * 4000),
                strokeColor: random() < 0.5 ? "#000" : "#f00",
              });
            }
          });
        }
        sync(a.scene, b.scene);
        const incremental = a.materializer.materialize();
        const fresh = new VaultSceneMaterializer(a.scene).materialize();
        expect(canonical(incremental.elements)).toBe(canonical(fresh.elements));
        expect(JSON.stringify(incremental.report)).toBe(
          JSON.stringify(fresh.report),
        );
        steps += 1;
      }
    }
    expect(steps).toBe(200);
    // 200 full re-materializations; ~2s alone, can exceed the 5s default when
    // the whole suite runs in parallel.
  }, 30_000);

  it("a remote edit of one element re-emits only its closure and keeps other objects", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    const before = a.materializer.materialize().elements;
    b.scene.transact(() => b.scene.writeFields("note-1", { x: 42 }));
    sync(a.scene, b.scene);
    const result = a.materializer.materialize();
    expect([...result.changedIds]).toEqual(["note-1"]);
    for (const id of ["box-1", "label-1", "box-2", "arrow-1"]) {
      expect(byId(result.elements, id)).toBe(byId(before, id));
    }
  });
});

describe("VaultSceneMaterializer · version stamp (R7)", () => {
  it("container resize that rewraps the label bumps the label's version and nonce", () => {
    const { scene, materializer } = seeded(
      "actor-a",
      buildBasicScene("hello world, this label wraps"),
    );
    const before = byId(materializer.materialize().elements, "label-1")!;
    scene.transact(() => scene.writeFields("box-1", { width: 150 }));
    const after = byId(materializer.materialize().elements, "label-1")!;
    expect(after.text).not.toBe(before.text);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.versionNonce).not.toBe(before.versionNonce);
  });

  it("stays monotone when unbinding shrinks the dependency set", () => {
    const { scene, materializer } = seeded();
    const box = () =>
      byId(materializer.materialize().elements, "box-1")!.version as number;
    const before = box();
    scene.transact(() =>
      scene.writeFields("label-1", {
        containerId: null,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    );
    expect(box()).toBeGreaterThan(before);
  });

  it("stays above the editor's own version", () => {
    const scene = new VaultSceneDoc({ actorId: "actor-a" });
    scene.transact(() => {
      for (const element of buildBasicScene()) {
        scene.createElement(element);
      }
    });
    const editor = new Map<string, number>();
    const materializer = new VaultSceneMaterializer(scene, {
      editorVersion: (id) => editor.get(id),
    });
    const first = byId(materializer.materialize().elements, "note-1")!;
    editor.set("note-1", first.version + 50); // editor mutated it locally
    scene.transact(() => scene.writeFields("note-1", { x: 1 }));
    expect(byId(materializer.materialize().elements, "note-1")!.version).toBe(
      first.version + 51,
    );
  });
});

describe("VaultSceneMaterializer · report", () => {
  it("reports a dangling arrow binding without repairing it", () => {
    const a = seeded("actor-a");
    a.scene.transact(() => a.scene.deleteElement("box-2"));
    const result = a.materializer.materialize();
    expect(result.report.danglingBindings).toEqual([
      { elementId: "arrow-1", field: "endBinding", targetId: "box-2" },
    ]);
    expect(byId(result.elements, "arrow-1")!.endBinding).toMatchObject({
      elementId: "box-2",
    });
  });
});
