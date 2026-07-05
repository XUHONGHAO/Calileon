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
 *  - addLightSource      在视口中心放置一个点光源椭圆并选中
 *  - addSun              放置一个平行光（sun）光源（M2）
 *  - changeMaterial      修改选中图形的材质（写入 customData.luminaMaterial）
 *  - changeLightProps    修改选中光源的颜色/强度/半径/类型（写 customData.luminaLight，M2）
 */

import {
  DEFAULT_ELEMENT_STROKE_COLOR_PALETTE,
  DEFAULT_ELEMENT_STROKE_PICKS,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";

import { CaptureUpdateAction, newElement } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import {
  DEFAULT_LUMINA_DIRECTION,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
  DEFAULT_LUMINA_SPOT_ANGLE,
  getLuminaLightData,
  getLuminaMaterial,
  isLuminaLightSource,
  normalizeLuminaLightData,
} from "@excalidraw/element/lumina";

import type {
  LuminaCustomData,
  LuminaLightData,
  LuminaLightType,
  LuminaMaterial,
} from "@excalidraw/element/lumina";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { t } from "../i18n";

import type { TranslationKeys } from "../i18n";
import { RadioSelection } from "../components/RadioSelection";
import { ColorPicker } from "../components/ColorPicker/ColorPicker";
import { Range } from "../components/Range";

import { register } from "./register";
import { changeProperty, getFormValue } from "./actionProperties";

import type { AppState } from "../types";

/** 光源宿主椭圆的默认像素尺寸。 */
const LIGHT_SOURCE_SIZE = 48;

export const actionToggleLumina = register({
  name: "toggleLumina",
  label: "labels.lumina.toggle",
  viewMode: true,
  trackEvent: {
    category: "canvas",
    predicate: (appState) => appState.luminaEnabled,
  },
  perform: (elements, appState) => {
    return {
      appState: {
        ...appState,
        luminaEnabled: !appState.luminaEnabled,
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  },
  checked: (appState: AppState) => appState.luminaEnabled,
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

    const light = newElement({
      type: "ellipse",
      x: centerX - LIGHT_SOURCE_SIZE / 2,
      y: centerY - LIGHT_SOURCE_SIZE / 2,
      width: LIGHT_SOURCE_SIZE,
      height: LIGHT_SOURCE_SIZE,
      backgroundColor: DEFAULT_LUMINA_LIGHT_COLOR,
      strokeColor: DEFAULT_LUMINA_LIGHT_COLOR,
      customData: { luminaLight: lightData } satisfies LuminaCustomData,
    });

    return {
      // 开启光源时自动打开光照总开关，否则放了光源也看不到效果。
      elements: [...elements, light],
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

    const sun = newElement({
      type: "ellipse",
      x: centerX - LIGHT_SOURCE_SIZE / 2,
      y: centerY - LIGHT_SOURCE_SIZE / 2,
      width: LIGHT_SOURCE_SIZE,
      height: LIGHT_SOURCE_SIZE,
      backgroundColor: DEFAULT_LUMINA_LIGHT_COLOR,
      strokeColor: DEFAULT_LUMINA_LIGHT_COLOR,
      customData: { luminaLight: lightData } satisfies LuminaCustomData,
    });

    return {
      elements: [...elements, sun],
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
            next.customData = {
              ...el.customData,
              luminaLight: normalizeLuminaLightData({
                ...current,
                ...customPatch,
              }),
            } satisfies LuminaCustomData;
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
      (hasSelection) =>
        hasSelection ? null : DEFAULT_LUMINA_LIGHT_INTENSITY,
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
          value={Math.round(((intensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY) / 3) * 100)}
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
