import { useCallback, useEffect, useRef, useState } from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import {
  invalidateVideoPlaybackURLCache,
  resolveCachedVideoPlaybackURL,
} from "../ai/videoPlaybackURLCache";

import type { CSSProperties } from "react";
import type { VideoPlaybackURLResolution } from "../ai/videoPlaybackURLCache";

type AIVideoAssetPlayerProps = {
  assetId: string;
  contextId: string;
  resolveAsset: () => Promise<VideoPlaybackURLResolution>;
  className?: string;
  style?: CSSProperties;
};

export const AIVideoAssetPlayer = ({
  assetId,
  contextId,
  resolveAsset,
  className,
  style,
}: AIVideoAssetPlayerProps) => {
  const [resolution, setResolution] =
    useState<VideoPlaybackURLResolution | null>(null);
  const [failed, setFailed] = useState(false);
  const retryCountRef = useRef(0);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const next = await resolveCachedVideoPlaybackURL({
        contextId,
        assetId,
        resolver: resolveAsset,
      });
      setResolution(next);
    } catch {
      setResolution(null);
      setFailed(true);
    }
  }, [assetId, contextId, resolveAsset]);

  useEffect(() => {
    retryCountRef.current = 0;
    void load();
  }, [load]);

  if (!resolution) {
    return (
      <div
        className={className}
        style={style}
        role="status"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {failed
          ? t("ai.workbench.videoAssetUnavailable")
          : t("ai.workbench.videoAssetLoading")}
      </div>
    );
  }

  return (
    <video
      className={className}
      style={style}
      src={resolution.url}
      controls
      playsInline
      preload="metadata"
      onPointerDown={(event) => event.stopPropagation()}
      onError={() => {
        if (retryCountRef.current >= 1) {
          setFailed(true);
          setResolution(null);
          return;
        }
        retryCountRef.current += 1;
        invalidateVideoPlaybackURLCache(contextId, assetId);
        void load();
      }}
    />
  );
};
