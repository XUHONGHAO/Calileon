import { useSyncExternalStore } from "react";

/**
 * Open state for Labs feature hosts. Menu items unmount when the main menu
 * closes, so they only flip this flag; the host (mounted next to the menu)
 * reads it and owns the actual dialog/panel.
 */
export type LabsFeatureId = "rorschach" | "shelfLife" | "synesthesia";

const openFeatures = new Set<LabsFeatureId>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export const openLabsFeature = (id: LabsFeatureId) => {
  if (!openFeatures.has(id)) {
    openFeatures.add(id);
    emit();
  }
};

export const closeLabsFeature = (id: LabsFeatureId) => {
  if (openFeatures.delete(id)) {
    emit();
  }
};

export const isLabsFeatureOpen = (id: LabsFeatureId) => openFeatures.has(id);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useLabsFeatureOpen = (id: LabsFeatureId) =>
  useSyncExternalStore(subscribe, () => openFeatures.has(id));
