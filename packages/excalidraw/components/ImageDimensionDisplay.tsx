import type { ExcalidrawImageElement } from "@excalidraw/element/types";

import { useImageNaturalSize } from "../hooks/useImageNaturalSize";
import { t } from "../i18n";

import type { BinaryFiles } from "../types";

/**
 * Shows the source pixel dimensions of the selected image.
 *
 * Rendered only when the image is the sole selection, so multi-image and
 * image+text selections stay uncluttered.
 */
export const ImageDimensionDisplay = ({
  element,
  files,
}: {
  element: ExcalidrawImageElement;
  files: BinaryFiles;
}) => {
  const size = useImageNaturalSize(element, files);

  return (
    <div className="image-dimension-display">
      <span className="image-dimension-display__label control-label">
        {t("labels.imageDimensions")}
      </span>
      <span className="image-dimension-display__value">
        {size ? `${size.width} × ${size.height}` : "—"}
      </span>
    </div>
  );
};
