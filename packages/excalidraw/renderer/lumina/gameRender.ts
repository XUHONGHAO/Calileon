import type { LuminaGamePhase } from "@excalidraw/element/lumina";

import type { LuminaViewport } from "./composite";
import type { LuminaLaserTarget } from "./game";
import type { LaserSegment, LaserTraceResult } from "./gameLaser";
import type {
  ShadowRevealRenderModel,
  ShadowRevealTargetRenderModel,
} from "./gameShadow";
import type { DarkRoomRenderModel } from "./gameDarkRoom";
import type { LuminaGameSessionSnapshot } from "./gameSession";

const TAU = Math.PI * 2;

const LASER_COLORS = {
  idleGlow: "rgba(25, 174, 255, 0.24)",
  idleCore: "rgba(126, 224, 255, 0.78)",
  hitGlow: "rgba(42, 255, 218, 0.52)",
  hitCore: "rgba(220, 255, 249, 0.98)",
  idleTarget: "rgba(103, 213, 255, 0.58)",
  hitTarget: "rgba(120, 255, 226, 0.98)",
} as const;

const SHADOW_COLORS = {
  editFill: "rgba(255, 191, 71, 0.13)",
  editOutline: "rgba(255, 191, 71, 0.92)",
  missingFill: "rgba(255, 158, 92, 0.2)",
  extraFill: "rgba(136, 113, 255, 0.15)",
  unmatchedOutline: "rgba(154, 132, 255, 0.9)",
  matchedFill: "rgba(83, 255, 184, 0.1)",
  matchedOutline: "rgba(113, 255, 190, 0.98)",
  scoreTrack: "rgba(28, 35, 55, 0.5)",
  scorePending: "rgba(191, 170, 255, 0.86)",
  scoreMatched: "rgba(113, 255, 190, 0.96)",
} as const;

const DARK_ROOM_COLORS = {
  veil: "rgba(4, 7, 16, 1)",
  editVeil: "rgba(4, 7, 16, 0.28)",
  guide: "rgba(255, 196, 82, 0.94)",
  revealed: "rgba(255, 218, 116, 1)",
  discovered: "rgba(255, 190, 66, 0.96)",
  scoreTrack: "rgba(15, 18, 28, 0.66)",
} as const;

const toDevicePoint = (
  point: readonly [number, number],
  viewport: LuminaViewport,
): [number, number] => {
  const transformScale = viewport.zoom * viewport.scale;
  return [
    (point[0] + viewport.scrollX) * transformScale,
    (point[1] + viewport.scrollY) * transformScale,
  ];
};

interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const getViewportSceneBounds = (
  viewport: LuminaViewport,
  marginCssPixels = 64,
): SceneBounds => {
  const zoom = Math.max(1e-6, viewport.zoom);
  const margin = marginCssPixels / zoom;
  return {
    minX: -viewport.scrollX - margin,
    minY: -viewport.scrollY - margin,
    maxX: viewport.width / zoom - viewport.scrollX + margin,
    maxY: viewport.height / zoom - viewport.scrollY + margin,
  };
};

const boundsIntersect = (left: SceneBounds, right: SceneBounds): boolean =>
  left.minX <= right.maxX &&
  left.maxX >= right.minX &&
  left.minY <= right.maxY &&
  left.maxY >= right.minY;

const pointsBounds = (
  points: readonly (readonly [number, number])[],
): SceneBounds | null => {
  if (points.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
};

const pointsAreVisible = (
  points: readonly (readonly [number, number])[],
  viewportBounds: SceneBounds,
): boolean => {
  const bounds = pointsBounds(points);
  return bounds ? boundsIntersect(bounds, viewportBounds) : false;
};

const laserPathIsVisible = (
  path: readonly LaserSegment[],
  viewportBounds: SceneBounds,
): boolean =>
  path.some((segment) =>
    pointsAreVisible([segment.from, segment.to], viewportBounds),
  );

const pointToSegmentDistance = (
  point: readonly [number, number],
  from: readonly [number, number],
  to: readonly [number, number],
): number => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    return Math.hypot(point[0] - from[0], point[1] - from[1]);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared,
    ),
  );
  return Math.hypot(
    point[0] - (from[0] + t * dx),
    point[1] - (from[1] + t * dy),
  );
};

const targetContainsPathEnd = (
  target: LuminaLaserTarget,
  endpoint: readonly [number, number],
): boolean => {
  const epsilon = Math.max(1e-3, target.radius * 1e-6);
  if (
    Math.hypot(
      endpoint[0] - target.center[0],
      endpoint[1] - target.center[1],
    ) <=
    target.radius + epsilon
  ) {
    return true;
  }
  return target.edges.some(
    (edge) => pointToSegmentDistance(endpoint, edge[0], edge[1]) <= epsilon,
  );
};

const pathHitsTarget = (
  path: readonly LaserSegment[],
  hitTargets: readonly LuminaLaserTarget[],
): boolean => {
  const endpoint = path.at(-1)?.to;
  return endpoint
    ? hitTargets.some((target) => targetContainsPathEnd(target, endpoint))
    : false;
};

const drawLaserPath = (
  ctx: CanvasRenderingContext2D,
  path: readonly LaserSegment[],
  viewport: LuminaViewport,
  hit: boolean,
) => {
  const first = path[0];
  if (!first) {
    return;
  }

  const [startX, startY] = toDevicePoint(first.from, viewport);
  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    for (const segment of path) {
      const [x, y] = toDevicePoint(segment.to, viewport);
      ctx.lineTo(x, y);
    }
  };

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  tracePath();
  ctx.strokeStyle = hit ? LASER_COLORS.hitGlow : LASER_COLORS.idleGlow;
  ctx.lineWidth = (hit ? 10 : 7) * viewport.scale;
  ctx.shadowColor = hit ? LASER_COLORS.hitTarget : LASER_COLORS.idleCore;
  ctx.shadowBlur = (hit ? 18 : 12) * viewport.scale;
  ctx.stroke();

  tracePath();
  ctx.strokeStyle = hit ? LASER_COLORS.hitCore : LASER_COLORS.idleCore;
  ctx.lineWidth = (hit ? 2.5 : 1.75) * viewport.scale;
  ctx.shadowBlur = (hit ? 6 : 3) * viewport.scale;
  ctx.stroke();
};

const drawTarget = (
  ctx: CanvasRenderingContext2D,
  target: LuminaLaserTarget,
  viewport: LuminaViewport,
  hit: boolean,
) => {
  const [x, y] = toDevicePoint(target.center, viewport);
  const radius = Math.max(
    4 * viewport.scale,
    target.radius * viewport.zoom * viewport.scale,
  );

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.strokeStyle = hit ? LASER_COLORS.hitTarget : LASER_COLORS.idleTarget;
  ctx.lineWidth = (hit ? 3 : 2) * viewport.scale;
  ctx.shadowColor = hit ? LASER_COLORS.hitTarget : LASER_COLORS.idleCore;
  ctx.shadowBlur = (hit ? 16 : 7) * viewport.scale;
  ctx.setLineDash(hit ? [] : [5 * viewport.scale, 4 * viewport.scale]);
  ctx.stroke();

  if (hit) {
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(2.5 * viewport.scale, radius * 0.18), 0, TAU);
    ctx.fillStyle = LASER_COLORS.hitCore;
    ctx.shadowBlur = 10 * viewport.scale;
    ctx.fill();
  }
};

const toDeviceRect = (
  bounds: ShadowRevealTargetRenderModel["bounds"],
  viewport: LuminaViewport,
) => {
  const [x, y] = toDevicePoint([bounds.minX, bounds.minY], viewport);
  const transformScale = viewport.zoom * viewport.scale;
  return {
    x,
    y,
    width: Math.max(1, (bounds.maxX - bounds.minX) * transformScale),
    height: Math.max(1, (bounds.maxY - bounds.minY) * transformScale),
  };
};

const drawShadowMaskCells = (
  ctx: CanvasRenderingContext2D,
  target: ShadowRevealTargetRenderModel,
  viewport: LuminaViewport,
  phase: LuminaGamePhase,
) => {
  const n = Math.max(1, target.expected.sampleSize);
  const rect = toDeviceRect(target.bounds, viewport);
  const cellWidth = rect.width / n;
  const cellHeight = rect.height / n;
  const length = Math.min(
    target.actual.cells.length,
    target.expected.cells.length,
  );

  for (let index = 0; index < length; index++) {
    const actual = target.actual.cells[index];
    const expected = target.expected.cells[index];
    let fillStyle: string | null = null;

    if (phase === "edit") {
      fillStyle = expected ? SHADOW_COLORS.editFill : null;
    } else if (target.matched) {
      fillStyle = expected ? SHADOW_COLORS.matchedFill : null;
    } else if (expected && !actual) {
      fillStyle = SHADOW_COLORS.missingFill;
    } else if (actual && !expected) {
      fillStyle = SHADOW_COLORS.extraFill;
    }

    if (!fillStyle) {
      continue;
    }

    const column = index % n;
    const row = Math.floor(index / n);
    ctx.fillStyle = fillStyle;
    ctx.fillRect(
      rect.x + column * cellWidth,
      rect.y + row * cellHeight,
      Math.max(1, cellWidth + 0.25 * viewport.scale),
      Math.max(1, cellHeight + 0.25 * viewport.scale),
    );
  }
};

const drawRequiredMarker = (
  ctx: CanvasRenderingContext2D,
  rect: ReturnType<typeof toDeviceRect>,
  viewport: LuminaViewport,
  color: string,
) => {
  const size = 5 * viewport.scale;
  const x = rect.x + size * 1.4;
  const y = rect.y + size * 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
};

const drawMatchedCheck = (
  ctx: CanvasRenderingContext2D,
  rect: ReturnType<typeof toDeviceRect>,
  viewport: LuminaViewport,
) => {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const size = Math.max(
    7 * viewport.scale,
    Math.min(rect.width, rect.height) * 0.13,
  );
  ctx.beginPath();
  ctx.moveTo(centerX - size, centerY);
  ctx.lineTo(centerX - size * 0.25, centerY + size * 0.7);
  ctx.lineTo(centerX + size, centerY - size * 0.8);
  ctx.strokeStyle = SHADOW_COLORS.matchedOutline;
  ctx.lineWidth = 3 * viewport.scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = SHADOW_COLORS.matchedOutline;
  ctx.shadowBlur = 10 * viewport.scale;
  ctx.stroke();
};

const drawShadowTarget = (
  ctx: CanvasRenderingContext2D,
  target: ShadowRevealTargetRenderModel,
  viewport: LuminaViewport,
  phase: LuminaGamePhase,
  pulseProgress: number | null,
) => {
  const rect = toDeviceRect(target.bounds, viewport);
  const matched = phase === "play" && target.matched;
  const outline =
    phase === "edit"
      ? SHADOW_COLORS.editOutline
      : matched
      ? SHADOW_COLORS.matchedOutline
      : SHADOW_COLORS.unmatchedOutline;

  ctx.strokeStyle = outline;
  ctx.lineWidth = (matched ? 3 : 2) * viewport.scale;
  ctx.shadowColor = outline;
  ctx.shadowBlur = (matched ? 14 : 6) * viewport.scale;
  ctx.setLineDash(
    matched
      ? []
      : phase === "edit"
      ? [8 * viewport.scale, 5 * viewport.scale]
      : [5 * viewport.scale, 4 * viewport.scale],
  );
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  const scoreHeight = Math.max(3, 3 * viewport.scale);
  const scoreY = rect.y + rect.height - scoreHeight;
  ctx.shadowBlur = 0;
  ctx.fillStyle = SHADOW_COLORS.scoreTrack;
  ctx.fillRect(rect.x, scoreY, rect.width, scoreHeight);
  ctx.fillStyle = matched
    ? SHADOW_COLORS.scoreMatched
    : SHADOW_COLORS.scorePending;
  ctx.fillRect(
    rect.x,
    scoreY,
    rect.width * Math.max(0, Math.min(1, target.score)),
    scoreHeight,
  );

  if (target.required) {
    drawRequiredMarker(ctx, rect, viewport, outline);
  }
  if (matched) {
    drawMatchedCheck(ctx, rect, viewport);
  }

  if (pulseProgress != null) {
    const progress = Math.max(0, Math.min(1, pulseProgress));
    const expansion = 14 * viewport.scale * progress;
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(113, 255, 190, ${0.75 * (1 - progress)})`;
    ctx.lineWidth = Math.max(1, 3 * viewport.scale * (1 - progress));
    ctx.shadowColor = SHADOW_COLORS.matchedOutline;
    ctx.shadowBlur = 18 * viewport.scale * (1 - progress);
    ctx.strokeRect(
      rect.x - expansion,
      rect.y - expansion,
      rect.width + expansion * 2,
      rect.height + expansion * 2,
    );
  }
};

export const getNewlyMatchedShadowTargetIds = (
  previous: ReadonlySet<string>,
  current: readonly string[],
): Set<string> => {
  return new Set(current.filter((id) => !previous.has(id)));
};

export const shouldAnimateShadowMatch = (
  phase: LuminaGamePhase,
  newlyMatchedCount: number,
  reduceMotion: boolean,
): boolean => {
  return phase === "play" && newlyMatchedCount > 0 && !reduceMotion;
};

/**
 * Draws the screen-only Lumina laser game overlay.
 *
 * The target canvas must be transparent and sit above LightingCanvas. Drawing
 * uses additive composition inside this canvas so the cyan beam stays luminous
 * without entering LightingCanvas' CSS multiply light-map.
 */
export const renderLuminaLaserOverlay = (
  ctx: CanvasRenderingContext2D,
  targets: readonly LuminaLaserTarget[],
  trace: LaserTraceResult,
  viewport: LuminaViewport,
): void => {
  const deviceWidth = Math.max(1, Math.floor(viewport.width * viewport.scale));
  const deviceHeight = Math.max(
    1,
    Math.floor(viewport.height * viewport.scale),
  );

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);
  ctx.globalCompositeOperation = "lighter";

  const hitTargetIds = new Set(trace.hitTargetIds);
  const hitTargets = targets.filter((target) => hitTargetIds.has(target.id));
  const viewportBounds = getViewportSceneBounds(viewport);

  for (const path of trace.paths) {
    if (!laserPathIsVisible(path, viewportBounds)) {
      continue;
    }
    drawLaserPath(ctx, path, viewport, pathHitsTarget(path, hitTargets));
  }

  for (const target of targets) {
    if (
      !boundsIntersect(viewportBounds, {
        minX: target.center[0] - target.radius,
        minY: target.center[1] - target.radius,
        maxX: target.center[0] + target.radius,
        maxY: target.center[1] + target.radius,
      })
    ) {
      continue;
    }
    drawTarget(ctx, target, viewport, hitTargetIds.has(target.id));
  }

  ctx.setLineDash([]);
  ctx.restore();
};

export interface LuminaShadowOverlayOptions {
  phase: LuminaGamePhase;
  pulseTargetIds?: ReadonlySet<string>;
  pulseProgress?: number | null;
}

/**
 * Draws shadow-reveal author guides and play feedback on the transparent game
 * canvas. The mask data comes from the same pure geometry evaluation used for
 * puzzle completion; canvas pixels never feed back into the rules.
 */
export const renderLuminaShadowOverlay = (
  ctx: CanvasRenderingContext2D,
  model: ShadowRevealRenderModel,
  viewport: LuminaViewport,
  options: LuminaShadowOverlayOptions,
): void => {
  const deviceWidth = Math.max(1, Math.floor(viewport.width * viewport.scale));
  const deviceHeight = Math.max(
    1,
    Math.floor(viewport.height * viewport.scale),
  );

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const viewportBounds = getViewportSceneBounds(viewport);

  for (const target of model.targets) {
    if (!boundsIntersect(viewportBounds, target.bounds)) {
      continue;
    }
    drawShadowMaskCells(ctx, target, viewport, options.phase);
    drawShadowTarget(
      ctx,
      target,
      viewport,
      options.phase,
      options.pulseTargetIds?.has(target.id)
        ? options.pulseProgress ?? 0
        : null,
    );
  }

  ctx.setLineDash([]);
  ctx.restore();
};

export interface LuminaDarkRoomOverlayOptions {
  phase: LuminaGamePhase;
  session: LuminaGameSessionSnapshot;
  pulseTargetIds?: ReadonlySet<string>;
  pulseProgress?: number | null;
}

const drawDarkRoomWindow = (
  ctx: CanvasRenderingContext2D,
  model: DarkRoomRenderModel,
  viewport: LuminaViewport,
) => {
  const transformScale = viewport.zoom * viewport.scale;
  const deviceWidth = Math.max(1, Math.floor(viewport.width * viewport.scale));
  const deviceHeight = Math.max(
    1,
    Math.floor(viewport.height * viewport.scale),
  );

  ctx.globalCompositeOperation = "destination-out";
  const viewportBounds = getViewportSceneBounds(viewport);
  for (const light of model.lights) {
    const alpha = Math.max(0, Math.min(0.96, light.intensity));
    if (alpha <= 0) {
      continue;
    }
    if (light.type === "sun") {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fillRect(0, 0, deviceWidth, deviceHeight);
      continue;
    }
    if (
      !boundsIntersect(viewportBounds, {
        minX: light.x - light.radius,
        minY: light.y - light.radius,
        maxX: light.x + light.radius,
        maxY: light.y + light.radius,
      })
    ) {
      continue;
    }

    ctx.save();
    ctx.setTransform(
      transformScale,
      0,
      0,
      transformScale,
      viewport.scrollX * transformScale,
      viewport.scrollY * transformScale,
    );
    if (light.type === "spot") {
      const direction = light.direction ?? 0;
      const halfAngle = light.angle ?? Math.PI / 4;
      const distance = Math.max(1, light.radius);
      ctx.beginPath();
      ctx.moveTo(light.x, light.y);
      ctx.lineTo(
        light.x + Math.cos(direction - halfAngle) * distance,
        light.y + Math.sin(direction - halfAngle) * distance,
      );
      ctx.lineTo(
        light.x + Math.cos(direction + halfAngle) * distance,
        light.y + Math.sin(direction + halfAngle) * distance,
      );
      ctx.closePath();
      ctx.clip();
    }
    const gradient = ctx.createRadialGradient(
      light.x,
      light.y,
      0,
      light.x,
      light.y,
      Math.max(1, light.radius),
    );
    gradient.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
    gradient.addColorStop(0.65, `rgba(0, 0, 0, ${alpha * 0.72})`);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(
      light.x - light.radius,
      light.y - light.radius,
      light.radius * 2,
      light.radius * 2,
    );
    ctx.restore();
  }

  ctx.setTransform(
    transformScale,
    0,
    0,
    transformScale,
    viewport.scrollX * transformScale,
    viewport.scrollY * transformScale,
  );
  for (const reflection of model.reflections) {
    if (!pointsAreVisible(reflection.polygon, viewportBounds)) {
      continue;
    }
    const alpha = Math.max(0, Math.min(0.9, reflection.intensity));
    if (alpha <= 0) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(reflection.polygon[0][0], reflection.polygon[0][1]);
    for (let index = 1; index < reflection.polygon.length; index++) {
      ctx.lineTo(reflection.polygon[index][0], reflection.polygon[index][1]);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
    ctx.fill();
  }

  ctx.globalCompositeOperation = "source-over";
  for (const shadow of model.shadowPolygons) {
    if (!pointsAreVisible(shadow.points, viewportBounds)) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(shadow.points[0][0], shadow.points[0][1]);
    for (let index = 1; index < shadow.points.length; index++) {
      ctx.lineTo(shadow.points[index][0], shadow.points[index][1]);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(4, 7, 16, ${Math.min(0.92, shadow.strength * 0.92)})`;
    ctx.fill();
  }
};

const drawDarkRoomTreasure = (
  ctx: CanvasRenderingContext2D,
  target: DarkRoomRenderModel["treasures"][number],
  viewport: LuminaViewport,
  options: LuminaDarkRoomOverlayOptions,
) => {
  const rect = toDeviceRect(target.bounds, viewport);
  const discovered = options.session.discoveredIds.includes(target.id);
  const visibleInPlay = target.revealed || discovered;
  if (options.phase === "play" && !visibleInPlay) {
    return;
  }

  const color =
    options.phase === "edit"
      ? DARK_ROOM_COLORS.guide
      : target.revealed
      ? DARK_ROOM_COLORS.revealed
      : DARK_ROOM_COLORS.discovered;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = color;
  ctx.lineWidth = (target.revealed ? 3 : 2) * viewport.scale;
  ctx.setLineDash(
    options.phase === "edit" ? [7 * viewport.scale, 5 * viewport.scale] : [],
  );
  ctx.shadowColor = color;
  ctx.shadowBlur = (target.revealed ? 16 : 8) * viewport.scale;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  if (options.phase === "edit") {
    const scoreHeight = Math.max(3, 3 * viewport.scale);
    ctx.shadowBlur = 0;
    ctx.fillStyle = DARK_ROOM_COLORS.scoreTrack;
    ctx.fillRect(
      rect.x,
      rect.y + rect.height - scoreHeight,
      rect.width,
      scoreHeight,
    );
    ctx.fillStyle = DARK_ROOM_COLORS.guide;
    ctx.fillRect(
      rect.x,
      rect.y + rect.height - scoreHeight,
      rect.width * Math.max(0, Math.min(1, target.threshold)),
      scoreHeight,
    );
    if (target.required) {
      drawRequiredMarker(ctx, rect, viewport, color);
    }
    return;
  }

  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const badgeRadius = Math.max(7, 8 * viewport.scale);
  ctx.setLineDash([]);
  ctx.shadowBlur = 12 * viewport.scale;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(centerX, centerY, badgeRadius, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(48, 31, 5, 0.9)";
  ctx.lineWidth = Math.max(1.5, 2 * viewport.scale);
  ctx.beginPath();
  ctx.moveTo(centerX - badgeRadius * 0.45, centerY);
  ctx.lineTo(centerX - badgeRadius * 0.08, centerY + badgeRadius * 0.35);
  ctx.lineTo(centerX + badgeRadius * 0.55, centerY - badgeRadius * 0.42);
  ctx.stroke();

  if (options.pulseTargetIds?.has(target.id) && options.pulseProgress != null) {
    const progress = Math.max(0, Math.min(1, options.pulseProgress));
    const radius = badgeRadius + 22 * viewport.scale * progress;
    ctx.strokeStyle = `rgba(255, 218, 116, ${0.8 * (1 - progress)})`;
    ctx.lineWidth = Math.max(1, 3 * viewport.scale * (1 - progress));
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, TAU);
    ctx.stroke();
  }
};

export const renderLuminaDarkRoomOverlay = (
  ctx: CanvasRenderingContext2D,
  model: DarkRoomRenderModel,
  viewport: LuminaViewport,
  options: LuminaDarkRoomOverlayOptions,
): void => {
  const deviceWidth = Math.max(1, Math.floor(viewport.width * viewport.scale));
  const deviceHeight = Math.max(
    1,
    Math.floor(viewport.height * viewport.scale),
  );

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, deviceWidth, deviceHeight);
  ctx.fillStyle =
    options.phase === "edit"
      ? DARK_ROOM_COLORS.editVeil
      : DARK_ROOM_COLORS.veil;
  ctx.fillRect(0, 0, deviceWidth, deviceHeight);
  drawDarkRoomWindow(ctx, model, viewport);

  const viewportBounds = getViewportSceneBounds(viewport);
  for (const treasure of model.treasures) {
    if (!boundsIntersect(viewportBounds, treasure.bounds)) {
      continue;
    }
    drawDarkRoomTreasure(ctx, treasure, viewport, options);
  }
  ctx.setLineDash([]);
  ctx.restore();
};

export type LuminaGameEffectsRenderModel =
  | {
      style: "laser";
      targets: readonly LuminaLaserTarget[];
      trace: LaserTraceResult;
    }
  | {
      style: "shadow-reveal";
      phase: LuminaGamePhase;
      model: ShadowRevealRenderModel;
    }
  | {
      style: "dark-room";
      phase: LuminaGamePhase;
      model: DarkRoomRenderModel;
      session: LuminaGameSessionSnapshot;
    };

export interface LuminaGameEffectsRenderOptions {
  pulseTargetIds?: ReadonlySet<string>;
  pulseProgress?: number | null;
}

/** Shared pure Canvas2D game renderer used by screen and optional raster export. */
export const renderLuminaGameEffects = (
  ctx: CanvasRenderingContext2D,
  renderModel: LuminaGameEffectsRenderModel,
  viewport: LuminaViewport,
  options: LuminaGameEffectsRenderOptions = {},
) => {
  if (renderModel.style === "laser") {
    renderLuminaLaserOverlay(
      ctx,
      renderModel.targets,
      renderModel.trace,
      viewport,
    );
    return;
  }
  if (renderModel.style === "shadow-reveal") {
    renderLuminaShadowOverlay(ctx, renderModel.model, viewport, {
      phase: renderModel.phase,
      pulseTargetIds: options.pulseTargetIds,
      pulseProgress: options.pulseProgress,
    });
    return;
  }
  renderLuminaDarkRoomOverlay(ctx, renderModel.model, viewport, {
    phase: renderModel.phase,
    session: renderModel.session,
    pulseTargetIds: options.pulseTargetIds,
    pulseProgress: options.pulseProgress,
  });
};

export const __gameRenderTesting = {
  boundsIntersect,
  getViewportSceneBounds,
  getNewlyMatchedShadowTargetIds,
  laserPathIsVisible,
  pathHitsTarget,
  pointsAreVisible,
  pointToSegmentDistance,
  shouldAnimateShadowMatch,
  toDeviceRect,
  toDevicePoint,
};
