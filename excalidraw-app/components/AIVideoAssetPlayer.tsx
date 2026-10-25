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
  // Callers pass an inline resolver, so it changes identity on every parent
  // render. Keep it in a ref: depending on it re-ran the effect each render,
  // which reset the one-retry budget and re-requested the URL.
  const resolveAssetRef = useRef(resolveAsset);
  resolveAssetRef.current = resolveAsset;
  // Drops responses from an older load (asset change, retry, unmount).
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setFailed(false);
    try {
      const next = await resolveCachedVideoPlaybackURL({
        contextId,
        assetId,
        resolver: () => resolveAssetRef.current(),
      });
      if (seq === requestSeqRef.current) {
        setResolution(next);
      }
    } catch {
      if (seq === requestSeqRef.current) {
        setResolution(null);
        setFailed(true);
      }
    }
  }, [assetId, contextId]);

  useEffect(() => {
    retryCountRef.current = 0;
    void load();
    return () => {
      requestSeqRef.current += 1;
    };
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
