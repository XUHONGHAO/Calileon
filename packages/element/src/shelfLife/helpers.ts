import { fixBindingsAfterDeletion } from "../binding";
import { newElementWith } from "../mutateElement";

import type { ExcalidrawElement } from "../types";

export type ShelfLifeData = { version: 1; expiresAt: number; setAt: number };
export const SHELF_LIFE_DAY = 86_400_000;
const validTime = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 8_640_000_000_000_000;

export const normalizeShelfLifeData = (
  value: unknown,
): ShelfLifeData | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const data = value as Partial<ShelfLifeData>;
  return data.version === 1 &&
    validTime(data.expiresAt) &&
    validTime(data.setAt)
    ? { version: 1, expiresAt: data.expiresAt, setAt: data.setAt }
    : null;
};
/**
 * Only rectangles are notes (user decision, 2026-10-23). A rectangle's bound
 * text follows it; ellipses, diamonds, images and loose text never carry a
 * shelf life (restore strips stale data from them).
 */
export const isShelfLifeSupportedElement = (
  element: Pick<ExcalidrawElement, "type">,
) => element.type === "rectangle";
export const getShelfLifeData = (element: ExcalidrawElement) =>
  isShelfLifeSupportedElement(element)
    ? normalizeShelfLifeData(element.customData?.shelfLife)
    : null;
export const updateShelfLifeCustomData = (
  customData: ExcalidrawElement["customData"],
  data: ShelfLifeData | null,
) => {
  if (data) {
    return { ...customData, shelfLife: data };
  }
  if (!customData || !("shelfLife" in customData)) {
    return customData;
  }
  const { shelfLife: _, ...rest } = customData;
  return Object.keys(rest).length ? rest : undefined;
};
export const getShelfLifeRoot = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
): ExcalidrawElement | null => {
  if (element.isDeleted) {
    return null;
  }
  if (element.type === "text" && element.containerId) {
    const container = elements.get(element.containerId);
    return container &&
      !container.isDeleted &&
      isShelfLifeSupportedElement(container)
      ? container
      : null;
  }
  return isShelfLifeSupportedElement(element) ? element : null;
};
export const getShelfLifeBadge = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  now = Date.now(),
) => {
  const root = getShelfLifeRoot(element, elements);
  const data = root ? getShelfLifeData(root) : null;
  if (!data || root !== element) {
    return null;
  }
  const remaining = data.expiresAt - now;
  if (remaining <= 0) {
    return null;
  }
  return {
    dueSoon: remaining <= SHELF_LIFE_DAY,
    label: formatShelfLifeBadgeLabel(data.expiresAt, now),
  };
};
const pad2 = (value: number) => `${value}`.padStart(2, "0");
/**
 * "10/28" for whole-day deadlines (they end at the next local midnight, so
 * name the last good day), "14:30" later today, "10/28 14:30" otherwise.
 */
export const formatShelfLifeBadgeLabel = (expiresAt: number, now: number) => {
  const at = new Date(expiresAt);
  const wholeDay = at.getHours() === 0 && at.getMinutes() === 0;
  const day = new Date(wholeDay ? expiresAt - 1 : expiresAt);
  const date = `${day.getMonth() + 1}/${day.getDate()}`;
  if (wholeDay) {
    return date;
  }
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return new Date(now).toDateString() === at.toDateString()
    ? time
    : `${date} ${time}`;
};
export const getShelfLifeVisualState = (
  data: ShelfLifeData | null,
  now = Date.now(),
) => {
  const age = data ? now - data.expiresAt : -1;
  const expired = age >= 0;
  const opacity =
    age < 3 * SHELF_LIFE_DAY
      ? 1
      : Math.max(
          0.4,
          (8 - Math.floor((age - 3 * SHELF_LIFE_DAY) / SHELF_LIFE_DAY)) / 10,
        );
  return { expired, opacity };
};
/**
 * Render switch for the user's own view (and their exports). Off hides the
 * tint, fading and badge; the stored deadlines and cleanup are untouched.
 */
let shelfLifeVisuals = true;
export const setShelfLifeVisualsEnabled = (enabled: boolean) => {
  shelfLifeVisuals = enabled;
};
export const isShelfLifeVisualsEnabled = () => shelfLifeVisuals;

/** What the renderers draw: always "fresh" while the visuals are off. */
export const getElementShelfLifeState = (
  element: ExcalidrawElement,
  elements: ReadonlyMap<string, ExcalidrawElement>,
  now = Date.now(),
) => {
  if (!shelfLifeVisuals) {
    return { expired: false, opacity: 1 };
  }
  const root = getShelfLifeRoot(element, elements);
  return getShelfLifeVisualState(root ? getShelfLifeData(root) : null, now);
};
export const isShelfLifeLocked = (
  root: ExcalidrawElement,
  elements: readonly ExcalidrawElement[],
) =>
  root.locked ||
  elements.some(
    (el) =>
      !el.isDeleted &&
      el.type === "text" &&
      el.containerId === root.id &&
      el.locked,
  );
export const getExpiredShelfLife = (
  elements: readonly ExcalidrawElement[],
  now = Date.now(),
) => {
  const map = new Map(elements.map((el) => [el.id, el]));
  const expired = elements.filter(
    (el) =>
      getShelfLifeRoot(el, map) === el &&
      getShelfLifeVisualState(getShelfLifeData(el), now).expired,
  );
  return {
    unlocked: expired.filter((el) => !isShelfLifeLocked(el, elements)),
    locked: expired.filter((el) => isShelfLifeLocked(el, elements)),
  };
};
export const getShelfLifeSelection = (
  elements: readonly ExcalidrawElement[],
  selected: Readonly<Record<string, boolean>>,
) => {
  const map = new Map(elements.map((el) => [el.id, el]));
  const roots = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    if (selected[el.id]) {
      const root = getShelfLifeRoot(el, map);
      if (root && !isShelfLifeLocked(root, elements)) {
        roots.set(root.id, root);
      }
    }
  }
  return [...roots.values()];
};
export const setShelfLifeForSelection = (
  elements: readonly ExcalidrawElement[],
  selected: Readonly<Record<string, boolean>>,
  data: ShelfLifeData | null,
) => {
  const ids = new Set(
    getShelfLifeSelection(elements, selected).map((el) => el.id),
  );
  return elements.map((el) => {
    if (!ids.has(el.id)) {
      return el;
    }
    const old = getShelfLifeData(el);
    if (
      (!data && !el.customData?.shelfLife) ||
      (data && old?.expiresAt === data.expiresAt && old.setAt === data.setAt)
    ) {
      return el;
    }
    return newElementWith(
      el,
      { customData: updateShelfLifeCustomData(el.customData, data) },
      true,
    );
  });
};
/** Work on detached copies: binding repair mutates elements, never the input scene. */
export const planShelfLifeCleanup = (
  elements: readonly ExcalidrawElement[],
  now = Date.now(),
) => {
  const { unlocked, locked } = getExpiredShelfLife(elements, now);
  const ids = new Set(unlocked.map((el) => el.id));
  const deletedIds = new Set(
    elements
      .filter(
        (el) =>
          ids.has(el.id) ||
          (!el.isDeleted &&
            el.type === "text" &&
            el.containerId &&
            ids.has(el.containerId)),
      )
      .map((el) => el.id),
  );
  if (!ids.size) {
    return { elements, deletedIds, count: 0, lockedCount: locked.length };
  }
  const copies = elements.map(
    (el) => JSON.parse(JSON.stringify(el)) as ExcalidrawElement,
  );
  const deleted = copies.filter((el) => deletedIds.has(el.id));
  fixBindingsAfterDeletion(copies, deleted);
  const next = copies.map((el, i) =>
    deletedIds.has(el.id)
      ? newElementWith(el, { isDeleted: true })
      : JSON.stringify(el) === JSON.stringify(elements[i])
      ? elements[i]
      : el,
  );
  return {
    elements: next,
    deletedIds,
    count: ids.size,
    lockedCount: locked.length,
  };
};
export type ShelfLifePreset = "today" | "week" | "threeDays" | "sevenDays";
export const getShelfLifeDeadline = (
  preset: ShelfLifePreset,
  now = Date.now(),
) => {
  if (preset === "threeDays" || preset === "sevenDays") {
    return now + (preset === "threeDays" ? 3 : 7) * SHELF_LIFE_DAY;
  }
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(
    date.getDate() + (preset === "today" ? 1 : 8 - (date.getDay() || 7)),
  );
  return date.getTime();
};
export const getShelfLifeDateDeadline = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  date.setDate(day + 1);
  return validTime(date.getTime()) ? date.getTime() : null;
};
