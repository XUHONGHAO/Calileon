import type { ExcalidrawElement } from "@excalidraw/element/types";

import { VaultSceneMaterializer } from "./materialize";
import { VaultSceneDoc, registerKey } from "./sceneDoc";
import { VaultSchemaError } from "./schema";
import {
  buildBasicScene,
  byId,
  canonical,
  replica,
  seeded,
  sync,
} from "./testUtils";

describe("VaultSceneDoc · registers (ADR 0030 §2.1, R5, R6)", () => {
  it("creates every sub-map with the element (R6) and never stores derived fields", () => {
    const { scene } = seeded();
    const json = scene.doc.toJSON() as any;
    const label = json.elements["label-1"];
    expect(Object.keys(label).sort()).toEqual([
      "__clocks",
      "__delete",
      "__fields",
    ]);
    const fields = Object.keys(label.__fields).map(
      (key) => key.split("\u0000")[0],
    );
    for (const derived of [
      "text",
      "originalText",
      "version",
      "versionNonce",
      "boundElements",
      "isDeleted",
      "id",
    ]) {
      expect(fields).not.toContain(derived);
    }
    expect(json.texts["label-1"]).toBe("hello world");
    // boundElements is derived (S10)
    expect(
      Object.keys(json.elements["box-1"].__fields).some((key) =>
        key.startsWith("boundElements"),
      ),
    ).toBe(false);
  });

  it("rejects unknown element types and a second creation of the same id (S2)", () => {
    const { scene } = seeded();
    expect(() =>
      scene.transact(() =>
        scene.createElement({
          ...buildBasicScene()[0],
          id: "x",
          type: "hologram",
        } as never),
      ),
    ).toThrow(VaultSchemaError);
    expect(() =>
      scene.transact(() => scene.createElement(buildBasicScene()[0])),
    ).toThrow(/already exists/);
  });

  it("one Lamport clock per transaction, above everything observed", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    const before = b.scene.observedMaxClock;
    b.scene.transact(() => {
      b.scene.writeFields("box-1", { x: 5 });
      b.scene.writeFields("note-1", { x: 7 });
    });
    expect(b.scene.readClocks("box-1")["actor-b"]).toBe(before + 1);
    expect(b.scene.readClocks("note-1")["actor-b"]).toBe(before + 1);
  });

  it("prune: a sequential overwrite leaves one entry and no conflict; concurrent writes keep both", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    b.scene.transact(() =>
      b.scene.writeFields("box-1", { strokeColor: "#f00" }),
    );
    sync(a.scene, b.scene);
    const fields = (a.scene.doc.toJSON() as any).elements["box-1"].__fields;
    expect(
      Object.keys(fields).filter((key) => key.startsWith("strokeColor")),
    ).toEqual([registerKey("strokeColor", "actor-b")]);
    expect(a.materializer.materialize().report.conflicts).toEqual([]);

    a.scene.transact(() =>
      a.scene.writeFields("box-1", { strokeColor: "#0f0" }),
    );
    b.scene.transact(() =>
      b.scene.writeFields("box-1", { strokeColor: "#00f" }),
    );
    sync(a.scene, b.scene);
    const ra = a.materializer.materialize();
    const rb = b.materializer.materialize();
    expect(canonical(ra.elements)).toBe(canonical(rb.elements));
    expect(ra.report.conflicts).toHaveLength(1);
    expect(ra.report.conflicts[0]).toMatchObject({
      elementId: "box-1",
      field: "strokeColor",
    });
  });

  it("first write of a field absent at creation: both concurrent writes survive, (c, actorId) decides (R6 fix)", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() =>
      a.scene.writeFields("box-1", { customData: { by: "a" } }),
    );
    b.scene.transact(() =>
      b.scene.writeFields("box-1", { customData: { by: "b" } }),
    );
    sync(a.scene, b.scene);
    const ea = a.materializer.materialize();
    // equal clocks → higher actorId wins, on every replica
    expect(byId(ea.elements, "box-1")!.customData).toEqual({ by: "b" });
    expect(
      byId(b.materializer.materialize().elements, "box-1")!.customData,
    ).toEqual({ by: "b" });
    expect(ea.report.conflicts.map((conflict) => conflict.field)).toEqual([
      "customData",
    ]);
  });

  it("appState: only the 5 converged keys", () => {
    const { scene } = seeded();
    scene.transact(() => scene.writeAppState("viewBackgroundColor", "#000"));
    expect(() =>
      scene.transact(() => scene.writeAppState("zoom" as never, 2)),
    ).toThrow(VaultSchemaError);
    const candidates = scene.readAppStateCandidates();
    expect([...candidates.keys()]).toEqual(["viewBackgroundColor"]);
  });

  it("refuses a document from an unknown schema version (fail-closed)", () => {
    const { scene } = seeded();
    scene.meta.set("schemaVersion", 3);
    expect(() => scene.assertSchema()).toThrow(/schemaVersion 3/);
  });
});

describe("VaultSceneDoc · deletion (ADR 0030 §2.5, R4)", () => {
  it("explicit delete is tombstone-wins against a concurrent edit", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() => a.scene.deleteElement("note-1"));
    b.scene.transact(() => b.scene.writeFields("note-1", { x: 999 }));
    sync(a.scene, b.scene);
    for (const r of [a, b]) {
      expect(
        byId(r.materializer.materialize().elements, "note-1")!.isDeleted,
      ).toBe(true);
    }
  });

  it("local undo of a local delete retracts only the own tombstone", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() => a.scene.deleteElement("note-1"));
    b.scene.transact(() => b.scene.deleteElement("note-1"));
    sync(a.scene, b.scene);
    expect(a.scene.transact(() => a.scene.retractDelete("note-1"))).toBe(false);
    sync(a.scene, b.scene);
    expect(
      byId(a.materializer.materialize().elements, "note-1")!.isDeleted,
    ).toBe(true);
    b.scene.transact(() => b.scene.retractDelete("note-1"));
    sync(a.scene, b.scene);
    expect(
      byId(a.materializer.materialize().elements, "note-1")!.isDeleted,
    ).toBe(false);
  });

  it("option (c): A clears while B types → B's text stays visible; both clear → hidden, no tombstone", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() => a.scene.editText("note-1", ""));
    b.scene.transact(() =>
      b.scene.editText("note-1", "note + more", { caretAfter: 11 }),
    );
    sync(a.scene, b.scene);
    const ea = a.materializer.materialize();
    expect(byId(ea.elements, "note-1")).toMatchObject({
      isDeleted: false,
      originalText: " + more",
    });
    b.scene.transact(() => b.scene.editText("note-1", ""));
    sync(a.scene, b.scene);
    const again = a.materializer.materialize();
    expect(byId(again.elements, "note-1")!.isDeleted).toBe(true);
    expect(again.report.implicitlyDeleted).toEqual(["note-1"]);
    expect(a.scene.readTombstones("note-1").size).toBe(0);
  });

  it("a hidden bound label leaves the container's derived boundElements", () => {
    const { scene, materializer } = seeded();
    scene.transact(() => scene.editText("label-1", ""));
    const box = byId(materializer.materialize().elements, "box-1")!;
    expect(box.boundElements).toEqual([{ type: "arrow", id: "arrow-1" }]);
  });
});

describe("VaultSceneDoc · text (R1)", () => {
  it("concurrent typing in one label merges character-wise on both replicas", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() =>
      a.scene.editText("label-1", "hello brave world", { caretAfter: 12 }),
    );
    b.scene.transact(() =>
      b.scene.editText("label-1", "hello world!", { caretAfter: 12 }),
    );
    sync(a.scene, b.scene);
    const ea = a.materializer.materialize().elements;
    expect(byId(ea, "label-1")!.originalText).toBe("hello brave world!");
    expect(canonical(ea)).toBe(
      canonical(b.materializer.materialize().elements),
    );
    // R3: char-merged text never reports a conflict
    expect(a.materializer.materialize().report.conflicts).toEqual([]);
  });

  it("derived wrap follows the merged text and container (never stored)", () => {
    const a = seeded("actor-a", buildBasicScene("short"));
    const b = replica("actor-b", a.scene);
    a.scene.transact(() =>
      a.scene.editText(
        "label-1",
        "a considerably longer label that has to wrap",
      ),
    );
    b.scene.transact(() => b.scene.writeFields("box-1", { width: 200 }));
    sync(a.scene, b.scene);
    const ea = a.materializer.materialize().elements;
    const label = byId(ea, "label-1")!;
    expect(label.text).toContain("\n");
    expect(canonical(ea)).toBe(
      canonical(b.materializer.materialize().elements),
    );
    // the container grew to fit (never shrinks)
    expect(byId(ea, "box-1")!.height).toBeGreaterThanOrEqual(80);
  });

  it("unbinding a label writes its placement registers", () => {
    const { scene, materializer } = seeded();
    const label = byId(
      materializer.materialize().elements,
      "label-1",
    )! as unknown as ExcalidrawElement;
    scene.transact(() =>
      scene.writeFields("label-1", {
        containerId: null,
        x: 1234,
        y: 56,
        width: label.width,
        height: label.height,
      }),
    );
    const after = byId(materializer.materialize().elements, "label-1")!;
    expect(after).toMatchObject({ containerId: null, x: 1234, y: 56 });
  });
});

describe("VaultSceneMaterializer · join from snapshot", () => {
  it("a replica built from the full state materializes the same scene", () => {
    const a = seeded("actor-a");
    a.scene.transact(() => a.scene.writeFields("box-2", { x: 1 }));
    const joined = new VaultSceneDoc({ actorId: "actor-z" });
    joined.applyRemoteUpdate(a.scene.encodeStateAsUpdate());
    const materializer = new VaultSceneMaterializer(joined);
    expect(canonical(materializer.materialize().elements)).toBe(
      canonical(a.materializer.materialize().elements),
    );
    expect(joined.observedMaxClock).toBe(a.scene.observedMaxClock);
  });
});
