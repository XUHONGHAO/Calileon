import {
  CaptureUpdateAction,
  getLineTone,
  isLineToneSupportedElement,
  newElementWith,
  updateLineToneCustomData,
} from "@excalidraw/element";

import type { LineTone } from "@excalidraw/element";

import { t } from "../i18n";
import { RadioSelection } from "../components/RadioSelection";
import {
  BlockedLineToneIcon,
  CertainLineToneIcon,
  NormalLineToneIcon,
  PossibleLineToneIcon,
  QuestionedLineToneIcon,
} from "../components/icons";

import { changeProperty, getFormValue } from "./actionProperties";
import { register } from "./register";

import type { TranslationKeys } from "../i18n";

export type LineToneValue = "normal" | LineTone;

const LINE_TONE_VALUES: readonly LineToneValue[] = [
  "normal",
  "certain",
  "possible",
  "blocked",
  "questioned",
];

const LINE_TONE_LABELS: Record<LineToneValue, TranslationKeys> = {
  normal: "labels.lineTone.normal",
  certain: "labels.lineTone.certain",
  possible: "labels.lineTone.possible",
  blocked: "labels.lineTone.blocked",
  questioned: "labels.lineTone.questioned",
};

const LINE_TONE_ICONS: Record<LineToneValue, React.JSX.Element> = {
  normal: NormalLineToneIcon,
  certain: CertainLineToneIcon,
  possible: PossibleLineToneIcon,
  blocked: BlockedLineToneIcon,
  questioned: QuestionedLineToneIcon,
};

export const actionChangeLineTone = register<LineTone | null>({
  name: "changeLineTone",
  label: "labels.lineTone.label",
  trackEvent: {
    category: "element",
    action: "line_tone",
  },
  predicate: (_elements, appState, _appProps, app) =>
    app.scene.getSelectedElements(appState).some(isLineToneSupportedElement),
  perform: (elements, appState, tone) => ({
    elements: changeProperty(elements, appState, (element) => {
      if (!isLineToneSupportedElement(element)) {
        return element;
      }

      if (
        (tone && getLineTone(element) === tone) ||
        (!tone && !element.customData?.lineTone)
      ) {
        return element;
      }

      const customData = updateLineToneCustomData(
        element.customData,
        tone ?? null,
      );
      return customData === element.customData
        ? element
        : newElementWith(element, { customData });
    }),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  }),
  PanelComponent: ({ elements, updateData, app }) => {
    const value = getFormValue<LineToneValue | null>(
      elements,
      app,
      (element) => getLineTone(element) ?? "normal",
      isLineToneSupportedElement,
      null,
    );

    return (
      <fieldset>
        <legend>{t("labels.lineTone.label")}</legend>
        <div className="buttonList">
          <RadioSelection
            type="button"
            options={LINE_TONE_VALUES.map((tone) => ({
              value: tone,
              text: t(LINE_TONE_LABELS[tone]),
              icon: LINE_TONE_ICONS[tone],
              testId: `line-tone-${tone}`,
            }))}
            value={value}
            onClick={(tone) => updateData(tone === "normal" ? null : tone)}
          />
        </div>
      </fieldset>
    );
  },
});
