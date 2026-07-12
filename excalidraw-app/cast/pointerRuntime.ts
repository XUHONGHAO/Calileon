export type CastPointerRuntimeUpdate = {
  pointer: { x: number; y: number };
  button?: string;
  visible?: boolean;
};

export type CastEditorPointerUpdate = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" };
  button?: string;
};

type Listener = (update: CastPointerRuntimeUpdate) => void;
const listeners = new Set<Listener>();

export const emitCastPointerUpdate = (update: CastPointerRuntimeUpdate) => {
  for (const listener of listeners) {
    listener(update);
  }
};

export const forwardCastEditorPointerUpdate = (
  update: CastEditorPointerUpdate,
) => {
  if (update.pointer.tool === "laser") {
    return false;
  }
  emitCastPointerUpdate({
    pointer: { x: update.pointer.x, y: update.pointer.y },
    button: update.button,
    visible: true,
  });
  return true;
};

export const subscribeCastPointerUpdate = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
