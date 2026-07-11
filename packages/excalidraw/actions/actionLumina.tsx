/**
 * C1 Lumina 光照玩法的编辑器动作（actions）。
 *
 * 采用 action（而非新增工具 / 新元素类型）实现，理由见技术设计文档
 * C1-lumina-technical-design.md §1.4 / 决策 0014：
 *  - 不改工具类型系统与 App.tsx 指针处理，落地轻、风险低；
 *  - 光源是「一个打了 luminaLight 标记的椭圆宿主」，复用现有元素机制。
 *
 * action 一览：
 *  - toggleLumina        全局开关（appState.luminaEnabled）
 *  - toggleLuminaCaustics 玻璃折射/焦散开关（appState.luminaCaustics）
 *  - addLightSource      在视口中心放置一个点光源椭圆并选中
 *  - addSun              放置一个平行光（sun）光源（M2）
 *  - changeMaterial      修改选中图形的材质（写入 customData.luminaMaterial）
 *  - changeLightProps    修改选中光源的颜色/强度/半径/类型（写 customData.luminaLight，M2）
 *  - changeLuminaGameRole 标记/清除 M3 游戏角色（M3b 起）
 *  - changeLuminaGameConstraint 修改 M3 游戏约束（M3c 起）
 *  - setLuminaGameMode   进入/退出 M3 游戏模式（M3b 起）
 *  - resetLuminaGame     恢复进入 play 时的关卡几何快照（M3b 起）
 */

import {
  arrayToMap,
  DEFAULT_ELEMENT_STROKE_COLOR_PALETTE,
  DEFAULT_ELEMENT_STROKE_PICKS,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import {
  CaptureUpdateAction,
  newElement,
  syncMovedIndices,
} from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import {
  DEFAULT_LUMINA_DIRECTION,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
  DEFAULT_LUMINA_SPOT_ANGLE,
  getLuminaGameData,
  getLuminaLightData,
  getLuminaMaterial,
  isLuminaLightSource,
  normalizeLuminaGameData,
  normalizeLuminaLightData,
} from "@excalidraw/element/lumina";

import type {
  LuminaCustomData,
  LuminaGameMode,
  LuminaGameRole,
  LuminaLightData,
  LuminaLightType,
  LuminaMaterial,
} from "@excalidraw/element/lumina";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { t } from "../i18n";

import { RadioSelection } from "../components/RadioSelection";
import { ColorPicker } from "../components/ColorPicker/ColorPicker";
import { Range } from "../components/Range";

import {
  applyLuminaGameResetSnapshot,
  captureLuminaGameResetSnapshot,
} from "../renderer/lumina/game";
import { clearLuminaGameSession } from "../renderer/lumina/gameSession";

import { register } from "./register";
import { changeProperty, getFormValue } from "./actionProperties";

import type { TranslationKeys } from "../i18n";

import type { AppClassProperties, AppState } from "../types";
import type { LuminaGameResetSnapshot } from "../renderer/lumina/game";

/** 光源宿主椭圆的默认像素尺寸。 */
const LIGHT_SOURCE_SIZE = 48;
const LUMINA_MAX_BOUNCES_MIN = 1;
const LUMINA_MAX_BOUNCES_MAX = 32;
const LUMINA_TARGET_TOLERANCE_MAX = 200;
const LUMINA_SHADOW_TOLERANCE_MAX = 1;

const appendLuminaElement = (
  elements: readonly ExcalidrawElement[],
  element: ExcalidrawElement,
) => {
  const nextElements = [...elements, element];
  return syncMovedIndices(nextElements, arrayToMap([element]));
};

export interface LuminaGameConstraintPatch {
  required?: boolean;
  tolerance?: number;
  puzzleId?: string;
  label?: string;
  maxBounces?: number;
}

const luminaGameSnapshots = new WeakMap<
  AppClassProperties,
  LuminaGameResetSnapshot
>();

const clearLuminaGameSnapshot = (app: AppClassProperties): void => {
  luminaGameSnapshots.delete(app);
};

const setLuminaGameSnapshot = (
  app: AppClassProperties,
  elements: readonly ExcalidrawElement[],
): void => {
  luminaGameSnapshots.set(app, captureLuminaGameResetSnapshot(elements));
};

export const actionToggleLumina = register({
  name: "toggleLumina",
  label: "labels.lumina.toggle",
  viewMode: true,
  trackEvent: {
    category: "canvas",
    predicate: (appState) => appState.luminaEnabled,
  },
  perform: (elements, appState, _value, app) => {
    const nextEnabled = !appState.luminaEnabled;
    if (!nextEnabled) {
      clearLuminaGameSnapshot(app);
    }
    return {
      appState: {
        ...appState,
        luminaEnabled: nextEnabled,
        luminaGameMode: nextEnabled ? appState.luminaGameMode : null,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  checked: (appState: AppState) => appState.luminaEnabled,
});

export const actionToggleLuminaCaustics = register({
  name: "toggleLuminaCaustics",
  label: "labels.lumina.caustics",
  viewMode: true,
  trackEvent: {
    category: "canvas",
    predicate: (appState) => appState.luminaCaustics,
  },
  perform: (_elements, appState) => ({
    appState: {
      ...appState,
      luminaEnabled: true,
      luminaCaustics: !appState.luminaCaustics,
    },
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  }),
  checked: (appState: AppState) => appState.luminaCaustics,
});

export const actionAddLightSource = register({
  name: "addLightSource",
  label: "labels.lumina.addLight",
  trackEvent: { category: "element" },
  perform: (elements, appState) => {
    // 视口中心 → 场景坐标。
    const { x: centerX, y: centerY } = viewportCoordsToSceneCoords(
      {
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      },
      appState,
    );

    const lightData = normalizeLuminaLightData({
      light: "point",
      color: DEFAULT_LUMINA_LIGHT_COLOR,
      intensity: DEFAULT_LUMINA_LIGHT_INTENSITY,
      castShadows: true,
    });

    const customData: LuminaCustomData = { luminaLight: lightData };

    const light = newElement({
      type: "ellipse",
      x: centerX - LIGHT_SOURCE_SIZE / 2,
      y: centerY - LIGHT_SOURCE_SIZE / 2,
      width: LIGHT_SOURCE_SIZE,
      height: LIGHT_SOURCE_SIZE,
      backgroundColor: DEFAULT_LUMINA_LIGHT_COLOR,
      strokeColor: DEFAULT_LUMINA_LIGHT_COLOR,
      customData,
    });

    return {
      // 开启光源时自动打开光照总开关，否则放了光源也看不到效果。
      elements: appendLuminaElement(elements, light),
      appState: {
        ...appState,
        luminaEnabled: true,
        selectedElementIds: { [light.id]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

const LUMINA_MATERIAL_LABEL_KEYS: Record<LuminaMaterial, TranslationKeys> = {
  solid: "labels.lumina.material.solid",
  translucent: "labels.lumina.material.translucent",
  glass: "labels.lumina.material.glass",
  mirror: "labels.lumina.material.mirror",
  emissive: "labels.lumina.material.emissive",
};

export const actionChangeMaterial = register<LuminaMaterial>({
  name: "changeMaterial",
  label: "labels.lumina.material.label",
  trackEvent: false,
  perform: (elements, appState, value) => {
    return {
      elements: changeProperty(elements, appState, (el) => {
        const prev = (el.customData ?? {}) as LuminaCustomData;
        return newElementWith(el, {
          customData: {
            ...el.customData,
            luminaMaterial: { ...prev.luminaMaterial, material: value },
          },
        });
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => {
    const materials: LuminaMaterial[] = [
      "solid",
      "translucent",
      "glass",
      "mirror",
      "emissive",
    ];

    return (
      <fieldset>
        <legend>{t("labels.lumina.material.label")}</legend>
        <div className="buttonList lumina-material-buttonList">
          <RadioSelection
            type="button"
            options={materials.map((material) => ({
              value: material,
              text: t(LUMINA_MATERIAL_LABEL_KEYS[material]),
              // 材质暂无专属图标，用短文案作为可见内容，text 作为 tooltip。
              icon: (
                <span className="lumina-material-option">
                  {t(LUMINA_MATERIAL_LABEL_KEYS[material])}
                </span>
              ),
              testId: `lumina-material-${material}`,
            }))}
            value={getFormValue(
              elements,
              app,
              (element) => getLuminaMaterial(element),
              // 光源宿主不参与材质设置。
              (element) => !isLuminaLightSource(element),
              (hasSelection) => (hasSelection ? null : "solid"),
            )}
            onClick={(value) => {
              updateData(value);
            }}
          />
        </div>
      </fieldset>
    );
  },
});

export const actionAddSun = register({
  name: "addSun",
  label: "labels.lumina.addSun",
  trackEvent: { category: "element" },
  perform: (elements, appState) => {
    // 视口中心 → 场景坐标。
    const { x: centerX, y: centerY } = viewportCoordsToSceneCoords(
      {
        clientX: appState.offsetLeft + appState.width / 2,
        clientY: appState.offsetTop + appState.height / 2,
      },
      appState,
    );

    // sun 是平行光：位置不影响照明（只用于选中/拖拽宿主），方向 direction 决定
    // 全图影子朝向。默认 direction=0（光沿 +x 传播），拖太阳绕圈即改 direction。
    const lightData = normalizeLuminaLightData({
      light: "sun",
      color: DEFAULT_LUMINA_LIGHT_COLOR,
      intensity: DEFAULT_LUMINA_LIGHT_INTENSITY,
      direction: 0,
      castShadows: true,
    });

    const customData: LuminaCustomData = { luminaLight: lightData };

    const sun = newElement({
      type: "ellipse",
      x: centerX - LIGHT_SOURCE_SIZE / 2,
      y: centerY - LIGHT_SOURCE_SIZE / 2,
      width: LIGHT_SOURCE_SIZE,
      height: LIGHT_SOURCE_SIZE,
      backgroundColor: DEFAULT_LUMINA_LIGHT_COLOR,
      strokeColor: DEFAULT_LUMINA_LIGHT_COLOR,
      customData,
    });

    return {
      elements: appendLuminaElement(elements, sun),
      appState: {
        ...appState,
        luminaEnabled: true,
        selectedElementIds: { [sun.id]: true },
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

const LUMINA_LIGHT_TYPE_LABEL_KEYS: Record<LuminaLightType, TranslationKeys> = {
  point: "labels.lumina.light.type.point",
  spot: "labels.lumina.light.type.spot",
  sun: "labels.lumina.light.type.sun",
};

/**
 * 光源属性面板：颜色 / 强度 / 半径 / 类型（0015 评审项 4 基础档）。
 * 只作用于选中的光源宿主（isLuminaLightSource），把改动写回
 * customData.luminaLight，保持双键模型（0015 D0）。
 *
 * value 是一个 Partial<LuminaLightData> 补丁：面板各控件只发自己那一项，
 * perform 合并进现有光源数据，其余字段不动。
 */
export const actionChangeLightProps = register<Partial<LuminaLightData>>({
  name: "changeLightProps",
  label: "labels.lumina.light.label",
  trackEvent: false,
  perform: (elements, appState, value) => {
    // direction 不落 customData：光束/太阳朝向 = 宿主元素自身的旋转角
    // （direction = angle + π/2，见 scene.ts）。方向滑杆改的其实是元素旋转，
    // 与拖旋转手柄同一个真相源，故这里把 direction 补丁翻译成 el.angle，其余
    // 字段照常写 customData。
    const { direction, ...customPatch } = value ?? {};
    const hasCustomPatch = Object.keys(customPatch).length > 0;
    return {
      elements: changeProperty(
        elements,
        appState,
        (el) => {
          // 只改光源宿主，普通元素原样返回。
          const current = getLuminaLightData(el);
          if (!current) {
            return el;
          }
          const next: Record<string, unknown> = {};
          if (direction != null) {
            next.angle = (direction - Math.PI / 2) as Radians;
          }
          if (hasCustomPatch) {
            const patchedCustomData: LuminaCustomData = {
              ...el.customData,
              luminaLight: normalizeLuminaLightData({
                ...current,
                ...customPatch,
              }),
            };
            next.customData = patchedCustomData;
          }
          return newElementWith(el, next);
        },
        // 非光源宿主不参与，避免误改。
        false,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => {
    const isLight = (element: ExcalidrawElement) =>
      isLuminaLightSource(element);

    const color = getFormValue(
      elements,
      app,
      (element) => getLuminaLightData(element)?.color ?? null,
      isLight,
      (hasSelection) => (hasSelection ? null : DEFAULT_LUMINA_LIGHT_COLOR),
    );

    const intensity = getFormValue(
      elements,
      app,
      (element) => getLuminaLightData(element)?.intensity ?? null,
      isLight,
      (hasSelection) => (hasSelection ? null : DEFAULT_LUMINA_LIGHT_INTENSITY),
    );

    const lightType = getFormValue<LuminaLightType | null>(
      elements,
      app,
      (element) => getLuminaLightData(element)?.light ?? null,
      isLight,
      (hasSelection) => (hasSelection ? null : "point"),
    );

    // 半径以 0..100 的滑杆表达（映射到场景像素），sun 不衰减故隐藏半径。
    const RADIUS_SLIDER_MAX = 2000;
    const rawRadius = getFormValue(
      elements,
      app,
      (element) => getLuminaLightData(element)?.radius ?? null,
      isLight,
      () => null,
    );

    // 聚光锥半角（弧度），spot 专用；滑杆以「整锥角度」0..180° 表达。
    const rawAngle = getFormValue(
      elements,
      app,
      (element) => getLuminaLightData(element)?.angle ?? null,
      isLight,
      () => null,
    );

    // 光传播方向（弧度），spot/sun 用；滑杆以 0..360° 表达。方向的**唯一真源
    // 是宿主元素自身的旋转角**（direction = element.angle + π/2），故滑杆读
    // element.angle、与旋转手柄同步；写则发 direction 补丁，perform 翻译回旋转。
    const rawDirection = getFormValue(
      elements,
      app,
      (element) => (isLight(element) ? element.angle + Math.PI / 2 : null),
      isLight,
      () => null,
    );

    const types: LuminaLightType[] = ["point", "spot", "sun"];

    return (
      <fieldset className="lumina-light-panel">
        <legend>{t("labels.lumina.light.label")}</legend>

        <div className="buttonList lumina-material-buttonList">
          <RadioSelection
            type="button"
            options={types.map((type) => ({
              value: type,
              text: t(LUMINA_LIGHT_TYPE_LABEL_KEYS[type]),
              icon: (
                <span className="lumina-material-option">
                  {t(LUMINA_LIGHT_TYPE_LABEL_KEYS[type])}
                </span>
              ),
              testId: `lumina-light-type-${type}`,
            }))}
            value={lightType}
            onClick={(value) => updateData({ light: value })}
          />
        </div>

        <ColorPicker
          topPicks={DEFAULT_ELEMENT_STROKE_PICKS}
          palette={DEFAULT_ELEMENT_STROKE_COLOR_PALETTE}
          type="elementStroke"
          label={t("labels.lumina.light.color")}
          color={color}
          onChange={(value) => updateData({ color: value })}
          elements={elements}
          appState={appState}
          updateData={updateData}
        />

        <Range
          label={t("labels.lumina.light.intensity")}
          value={Math.round(
            ((intensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY) / 3) * 100,
          )}
          hasCommonValue={intensity !== null}
          onChange={(v) => updateData({ intensity: (v / 100) * 3 })}
          min={0}
          max={100}
          step={5}
          testId="lumina-light-intensity"
        />

        {lightType !== "sun" && (
          <Range
            label={t("labels.lumina.light.radius")}
            value={Math.round(
              Math.min(rawRadius ?? 600, RADIUS_SLIDER_MAX) /
                (RADIUS_SLIDER_MAX / 100),
            )}
            hasCommonValue={rawRadius !== null}
            onChange={(v) =>
              updateData({ radius: (v / 100) * RADIUS_SLIDER_MAX })
            }
            min={0}
            max={100}
            step={5}
            testId="lumina-light-radius"
          />
        )}

        {lightType === "spot" && (
          <Range
            label={t("labels.lumina.light.cone")}
            // 存的是**半角**（弧度）；滑杆按**整锥角度** 10..170° 表达。
            value={Math.round(
              ((rawAngle ?? DEFAULT_LUMINA_SPOT_ANGLE) * 2 * 180) / Math.PI,
            )}
            hasCommonValue={rawAngle !== null}
            onChange={(deg) =>
              updateData({ angle: ((deg / 2) * Math.PI) / 180 })
            }
            min={10}
            max={170}
            step={5}
            testId="lumina-light-cone"
          />
        )}

        {lightType !== "point" && (
          <Range
            label={t("labels.lumina.light.direction")}
            // 存的是弧度 0..2π；滑杆按角度 0..360° 表达。
            value={Math.round(
              (((rawDirection ?? DEFAULT_LUMINA_DIRECTION) * 180) / Math.PI +
                360) %
                360,
            )}
            hasCommonValue={rawDirection !== null}
            onChange={(deg) => updateData({ direction: (deg * Math.PI) / 180 })}
            min={0}
            max={360}
            step={5}
            testId="lumina-light-direction"
          />
        )}
      </fieldset>
    );
  },
});

const LUMINA_GAME_ROLE_LABEL_KEYS: Record<
  "none" | "target" | "emitter" | "shadowTarget" | "treasure",
  TranslationKeys
> = {
  none: "labels.lumina.game.role.none",
  target: "labels.lumina.game.role.target",
  emitter: "labels.lumina.game.role.emitter",
  shadowTarget: "labels.lumina.game.role.shadowTarget",
  treasure: "labels.lumina.game.role.treasure",
};

const clampTargetTolerance = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(LUMINA_TARGET_TOLERANCE_MAX, value))
    : undefined;
};

const clampMaxBounces = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(
        LUMINA_MAX_BOUNCES_MIN,
        Math.min(LUMINA_MAX_BOUNCES_MAX, Math.round(value)),
      )
    : undefined;
};

const clampShadowTolerance = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(LUMINA_SHADOW_TOLERANCE_MAX, value))
    : undefined;
};

export const actionChangeLuminaGameRole = register<LuminaGameRole | null>({
  name: "changeLuminaGameRole",
  label: "labels.lumina.game.role.label",
  trackEvent: false,
  perform: (elements, appState, value) => {
    return {
      elements: changeProperty(elements, appState, (el) => {
        const nextCustomData = {
          ...(el.customData ?? {}),
        } as LuminaCustomData;

        if (value == null) {
          delete nextCustomData.luminaGame;
        } else {
          nextCustomData.luminaGame = normalizeLuminaGameData({
            ...getLuminaGameData(el),
            role: value,
          });
        }

        return newElementWith(el, { customData: nextCustomData });
      }),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, updateData, app }) => {
    const role = getFormValue<LuminaGameRole | null>(
      elements,
      app,
      (element) => getLuminaGameData(element)?.role ?? null,
      () => true,
      (hasSelection) => (hasSelection ? null : null),
    );

    return (
      <fieldset>
        <legend>{t("labels.lumina.game.role.label")}</legend>
        <div className="buttonList lumina-material-buttonList">
          <RadioSelection
            type="button"
            options={[
              {
                value: "none",
                text: t(LUMINA_GAME_ROLE_LABEL_KEYS.none),
                icon: (
                  <span className="lumina-material-option">
                    {t(LUMINA_GAME_ROLE_LABEL_KEYS.none)}
                  </span>
                ),
                testId: "lumina-game-role-none",
              },
              {
                value: "target",
                text: t(LUMINA_GAME_ROLE_LABEL_KEYS.target),
                icon: (
                  <span className="lumina-material-option">
                    {t(LUMINA_GAME_ROLE_LABEL_KEYS.target)}
                  </span>
                ),
                testId: "lumina-game-role-target",
              },
              {
                value: "emitter",
                text: t(LUMINA_GAME_ROLE_LABEL_KEYS.emitter),
                icon: (
                  <span className="lumina-material-option">
                    {t(LUMINA_GAME_ROLE_LABEL_KEYS.emitter)}
                  </span>
                ),
                testId: "lumina-game-role-emitter",
              },
              {
                value: "shadowTarget",
                text: t(LUMINA_GAME_ROLE_LABEL_KEYS.shadowTarget),
                icon: (
                  <span className="lumina-material-option">
                    {t(LUMINA_GAME_ROLE_LABEL_KEYS.shadowTarget)}
                  </span>
                ),
                testId: "lumina-game-role-shadow-target",
              },
              {
                value: "treasure",
                text: t(LUMINA_GAME_ROLE_LABEL_KEYS.treasure),
                icon: (
                  <span className="lumina-material-option">
                    {t(LUMINA_GAME_ROLE_LABEL_KEYS.treasure)}
                  </span>
                ),
                testId: "lumina-game-role-treasure",
              },
            ]}
            value={
              role === "target" ||
              role === "emitter" ||
              role === "shadowTarget" ||
              role === "treasure"
                ? role
                : "none"
            }
            onClick={(value) => updateData(value === "none" ? null : value)}
          />
        </div>
      </fieldset>
    );
  },
});

export const actionChangeLuminaGameConstraint =
  register<LuminaGameConstraintPatch>({
    name: "changeLuminaGameConstraint",
    label: "labels.lumina.game.constraints.label",
    trackEvent: false,
    perform: (elements, appState, value) => {
      return {
        elements: changeProperty(elements, appState, (el) => {
          const current = getLuminaGameData(el);
          if (!current || !value) {
            return el;
          }

          const next = normalizeLuminaGameData(current);
          if ("required" in value) {
            next.required = value.required;
          }
          if ("tolerance" in value) {
            const tolerance =
              current.role === "shadowTarget" || current.role === "treasure"
                ? clampShadowTolerance(value.tolerance)
                : clampTargetTolerance(value.tolerance);
            if (tolerance !== undefined) {
              next.tolerance = tolerance;
            }
          }
          if ("puzzleId" in value) {
            const puzzleId = value.puzzleId?.trim();
            next.puzzleId = puzzleId || undefined;
          }
          if ("label" in value) {
            const label = value.label?.trim();
            next.label = label || undefined;
          }
          if ("maxBounces" in value) {
            const maxBounces = clampMaxBounces(value.maxBounces);
            if (maxBounces !== undefined) {
              next.meta = {
                ...(next.meta ?? {}),
                maxBounces,
              };
            }
          }

          return newElementWith(el, {
            customData: {
              ...el.customData,
              luminaGame: next,
            },
          });
        }),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      };
    },
    PanelComponent: ({ elements, updateData, app }) => {
      const role = getFormValue<LuminaGameRole | null>(
        elements,
        app,
        (element) => getLuminaGameData(element)?.role ?? null,
        (element) => getLuminaGameData(element) !== null,
        () => null,
      );
      if (!role) {
        return null;
      }

      const required = getFormValue<boolean | null>(
        elements,
        app,
        (element) => getLuminaGameData(element)?.required ?? true,
        (element) => getLuminaGameData(element) !== null,
        () => true,
      );
      const tolerance = getFormValue<number | null>(
        elements,
        app,
        (element) => getLuminaGameData(element)?.tolerance ?? null,
        (element) => getLuminaGameData(element) !== null,
        () => null,
      );
      const puzzleId = getFormValue<string | null>(
        elements,
        app,
        (element) => getLuminaGameData(element)?.puzzleId ?? null,
        (element) => getLuminaGameData(element) !== null,
        () => null,
      );
      const label = getFormValue<string | null>(
        elements,
        app,
        (element) => getLuminaGameData(element)?.label ?? null,
        (element) => getLuminaGameData(element) !== null,
        () => null,
      );
      const maxBounces = getFormValue<number | null>(
        elements,
        app,
        (element) => {
          const raw = getLuminaGameData(element)?.meta?.maxBounces;
          return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
        },
        (element) => getLuminaGameData(element)?.role === "emitter",
        () => null,
      );
      const toleranceValue =
        role === "shadowTarget" || role === "treasure"
          ? Math.round((tolerance ?? (role === "treasure" ? 0.35 : 0.15)) * 100)
          : Math.round(tolerance ?? 24);

      return (
        <fieldset className="lumina-game-constraints-panel">
          <legend>{t("labels.lumina.game.constraints.label")}</legend>

          <label>
            <input
              type="checkbox"
              checked={required ?? true}
              onChange={(event) =>
                updateData({ required: event.currentTarget.checked })
              }
              data-testid="lumina-game-required"
            />{" "}
            {t("labels.lumina.game.constraints.required")}
          </label>

          <Range
            label={t("labels.lumina.game.constraints.tolerance")}
            value={toleranceValue}
            hasCommonValue={tolerance !== null}
            onChange={(value) =>
              updateData({
                tolerance:
                  role === "shadowTarget" || role === "treasure"
                    ? value / 100
                    : value,
              })
            }
            min={0}
            max={
              role === "shadowTarget" || role === "treasure"
                ? 100
                : LUMINA_TARGET_TOLERANCE_MAX
            }
            step={1}
            testId="lumina-game-tolerance"
          />

          {role === "emitter" && (
            <Range
              label={t("labels.lumina.game.constraints.maxBounces")}
              value={Math.round(maxBounces ?? 8)}
              hasCommonValue={maxBounces !== null}
              onChange={(value) => updateData({ maxBounces: value })}
              min={LUMINA_MAX_BOUNCES_MIN}
              max={LUMINA_MAX_BOUNCES_MAX}
              step={1}
              testId="lumina-game-max-bounces"
            />
          )}

          <label>
            {t("labels.lumina.game.constraints.puzzleId")}
            <input
              value={puzzleId ?? ""}
              onChange={(event) =>
                updateData({ puzzleId: event.currentTarget.value })
              }
              data-testid="lumina-game-puzzle-id"
            />
          </label>

          <label>
            {t("labels.lumina.game.constraints.elementLabel")}
            <input
              value={label ?? ""}
              onChange={(event) =>
                updateData({ label: event.currentTarget.value })
              }
              data-testid="lumina-game-label"
            />
          </label>
        </fieldset>
      );
    },
  });

export const actionSetLuminaGameMode = register<LuminaGameMode | null>({
  name: "setLuminaGameMode",
  label: "labels.lumina.game.label",
  trackEvent: { category: "canvas" },
  perform: (elements, appState, value, app) => {
    if (value?.phase === "play") {
      setLuminaGameSnapshot(app, elements);
    } else {
      clearLuminaGameSnapshot(app);
    }
    return {
      appState: {
        ...appState,
        luminaEnabled: value ? true : appState.luminaEnabled,
        luminaGameMode: value,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
});

export const actionResetLuminaGame = register({
  name: "resetLuminaGame",
  label: "labels.lumina.game.reset",
  trackEvent: { category: "canvas" },
  predicate: (_elements, appState) =>
    appState.luminaEnabled && appState.luminaGameMode?.phase === "play",
  perform: (elements, appState, _value, app) => {
    const snapshot = luminaGameSnapshots.get(app);
    if (!snapshot) {
      return false;
    }
    clearLuminaGameSession(appState.luminaGameMode);
    return {
      elements: applyLuminaGameResetSnapshot(elements, snapshot),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
