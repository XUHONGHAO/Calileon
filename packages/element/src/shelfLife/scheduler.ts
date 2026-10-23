import {
  getShelfLifeData,
  getShelfLifeRoot,
  getShelfLifeVisualState,
  SHELF_LIFE_DAY,
} from "./helpers";

import type { ExcalidrawElement } from "../types";

/** A visual clock only. Does not modify elements, store or history. */
export const createShelfLifeScheduler = ({
  getElements,
  subscribe,
  redraw,
  document: doc = document,
  now = Date.now,
}: {
  getElements: () => readonly ExcalidrawElement[];
  subscribe: (callback: () => void) => () => void;
  redraw: () => void;
  document?: Document;
  now?: () => number;
}) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let signature = "";
  let tracked: ExcalidrawElement[] = [];
  const snapshot = () =>
    tracked
      .map((el) => {
        const data = getShelfLifeData(el);
        const at = now();
        const state = getShelfLifeVisualState(data, at);
        // Entering the last day flips the selected badge to the accent color.
        const dueSoon = !!data && data.expiresAt - at <= SHELF_LIFE_DAY;
        return `${el.id}:${state.expired}:${state.opacity}:${dueSoon}`;
      })
      .join("|");
  const check = () => {
    const next = snapshot();
    if (next !== signature) {
      signature = next;
      redraw();
    }
  };
  const arrange = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (!disposed && tracked.length && !doc.hidden) {
      timer = setInterval(check, 60_000);
    }
  };
  const index = () => {
    const elements = getElements();
    const map = new Map(elements.map((el) => [el.id, el]));
    tracked = elements.filter(
      (el) => getShelfLifeRoot(el, map) === el && getShelfLifeData(el),
    );
    signature = snapshot(); // Scene updates already render; never request another render here.
    arrange();
  };
  const visible = () => {
    if (!doc.hidden) {
      check();
    }
    arrange();
  };
  const unsubscribe = subscribe(index);
  doc.addEventListener("visibilitychange", visible);
  index();
  return () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
    }
    unsubscribe();
    doc.removeEventListener("visibilitychange", visible);
  };
};
