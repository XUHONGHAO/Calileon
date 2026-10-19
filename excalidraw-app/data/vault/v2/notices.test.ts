import { hasDeletedLocalEdit, VaultV2NoticeTracker } from "./notices";
import { replica, seeded, sync } from "./testUtils";

/** a and b both have the basic scene; b's tracker has seen the first sync */
const setup = () => {
  const a = seeded("actor-a");
  const b = replica("actor-b", a.scene);
  const tracker = new VaultV2NoticeTracker(b.scene);
  const first = b.materializer.materialize();
  expect(tracker.update(first.report, first.changedIds)).toEqual([]);
  tracker.arm();
  return { a, b, tracker };
};

const step = (r: ReturnType<typeof replica>, tracker: VaultV2NoticeTracker) => {
  const result = r.materializer.materialize();
  return tracker.update(result.report, result.changedIds);
};

describe("Vault v2 notices (W6)", () => {
  it("announces a concurrent register edit once and lists the element", () => {
    const { a, b, tracker } = setup();
    a.scene.transact(() => a.scene.writeFields("box-2", { x: 1 }));
    b.scene.transact(() => b.scene.writeFields("box-2", { x: 2 }));
    sync(a.scene, b.scene);

    expect(step(b, tracker)).toEqual([
      { kind: "conflict", elementIds: ["box-2"] },
    ]);
    expect(tracker.conflictElementIds).toEqual(["box-2"]);
    // still a conflict, but not news any more
    expect(step(b, tracker)).toEqual([]);
    expect(tracker.conflictElementIds).toEqual(["box-2"]);

    // a later edit that saw both values resolves it
    b.scene.transact(() => b.scene.writeFields("box-2", { x: 3 }));
    step(b, tracker);
    expect(tracker.conflictElementIds).toEqual([]);
  });

  it("does not replay conflicts that existed before the first sync", () => {
    const a = seeded("actor-a");
    const b = replica("actor-b", a.scene);
    a.scene.transact(() => a.scene.writeFields("box-2", { x: 1 }));
    b.scene.transact(() => b.scene.writeFields("box-2", { x: 2 }));
    sync(a.scene, b.scene);

    const c = replica("actor-c", b.scene);
    const tracker = new VaultV2NoticeTracker(c.scene);
    expect(step(c, tracker)).toEqual([]);
    tracker.arm();
    expect(step(c, tracker)).toEqual([]);
    expect(tracker.conflictElementIds).toEqual(["box-2"]);
  });

  it("does not treat a character-level text merge as a conflict", () => {
    const { a, b, tracker } = setup();
    a.scene.transact(() =>
      a.scene.applySplice("note-1", { index: 0, deleteCount: 0, insert: "A" }),
    );
    b.scene.transact(() =>
      b.scene.applySplice("note-1", { index: 4, deleteCount: 0, insert: "B" }),
    );
    sync(a.scene, b.scene);
    expect(step(b, tracker)).toEqual([]);
    expect(tracker.conflictElementIds).toEqual([]);
  });

  it("tells the editor once when a delete hid their concurrent edit", () => {
    const { a, b, tracker } = setup();
    a.scene.transact(() => a.scene.deleteElement("box-2"));
    b.scene.transact(() => b.scene.writeFields("box-2", { x: 99 }));
    sync(a.scene, b.scene);

    expect(hasDeletedLocalEdit(b.scene, "box-2")).toBe(true);
    // the deleter's own replica has nothing to report
    expect(hasDeletedLocalEdit(a.scene, "box-2")).toBe(false);
    expect(step(b, tracker)).toEqual([
      { kind: "deletedEdits", elementIds: ["box-2"] },
    ]);
    expect(step(b, tracker)).toEqual([]);
  });

  it("stays quiet when the deleter had seen the edit", () => {
    const { a, b, tracker } = setup();
    b.scene.transact(() => b.scene.writeFields("box-2", { x: 99 }));
    sync(a.scene, b.scene);
    step(b, tracker);
    a.scene.transact(() => a.scene.deleteElement("box-2"));
    sync(a.scene, b.scene);

    expect(hasDeletedLocalEdit(b.scene, "box-2")).toBe(false);
    expect(step(b, tracker)).toEqual([]);
  });
});
