import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/**
 * Frozen contract between AppMainMenu and every Labs feature module.
 * Feature branches must not change these props or AppMainMenu itself; add
 * new inputs inside the feature folder instead.
 */
export type LabsMenuItemProps = {
  /** True in Vault mode: features that send data off-device must hide. */
  externalFeaturesDisabled: boolean;
};

export type LabsHostProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  externalFeaturesDisabled: boolean;
};
