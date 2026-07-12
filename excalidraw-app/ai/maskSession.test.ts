import {
  appendAIMaskStrokePoint,
  beginAIMaskStroke,
  createAIMaskSession,
  endAIMaskStroke,
  redoAIMaskSession,
  undoAIMaskSession,
} from "./maskSession";

describe("AI mask session", () => {
  it("builds draw and erase strokes entirely in memory", () => {
    let session = createAIMaskSession();

    session = beginAIMaskStroke(session, {
      sceneX: 10,
      sceneY: 20,
      isErasing: false,
      brushSize: 24,
    });
    session = appendAIMaskStrokePoint(session, 30, 45);
    session = endAIMaskStroke(session);
    session = beginAIMaskStroke(session, {
      sceneX: 15,
      sceneY: 25,
      isErasing: true,
      brushSize: 18,
    });
    session = appendAIMaskStrokePoint(session, 22, 32);
    session = endAIMaskStroke(session);

    expect(session.elements).toHaveLength(2);
    expect(session.elements[0]).toMatchObject({
      strokeColor: "#ffffff",
      strokeWidth: 24,
      x: 10,
      y: 20,
      width: 20,
      height: 25,
    });
    expect(session.elements[1]).toMatchObject({
      strokeColor: "#000000",
      strokeWidth: 18,
    });
  });

  it("undoes and redoes whole strokes without mutating the initial payload", () => {
    const initial = createAIMaskSession();
    const withStroke = endAIMaskStroke(
      appendAIMaskStrokePoint(
        beginAIMaskStroke(initial, {
          sceneX: 1,
          sceneY: 2,
          isErasing: false,
          brushSize: 20,
        }),
        3,
        4,
      ),
    );

    const undone = undoAIMaskSession(withStroke);
    const redone = redoAIMaskSession(undone);

    expect(initial.elements).toEqual([]);
    expect(undone.elements).toEqual([]);
    expect(redone.elements).toHaveLength(1);
    expect(redone.activeElementId).toBeNull();
  });
});
