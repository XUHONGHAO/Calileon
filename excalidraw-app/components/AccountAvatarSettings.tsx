/**
 * Account avatar settings (ADR 0034 §6): a circle with a preset background
 * color and one CJK ideograph or A–Z letter, ringed in the theme primary.
 * Stored in `user_metadata.avatar`; voice bubbles snapshot it at recording.
 */

import { AUDIO_AVATAR_COLORS, THEME } from "@excalidraw/common";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { t } from "@excalidraw/excalidraw/i18n";
import { AudioAvatar } from "@excalidraw/excalidraw/voice/AudioAvatar";
import {
  getDefaultAudioAvatar,
  isValidAudioAvatarGlyph,
} from "@excalidraw/element";
import clsx from "clsx";
import React, { useEffect, useId, useRef, useState } from "react";

import type { AudioAvatar as AudioAvatarData } from "@excalidraw/element/types";

import { useCloudAuth } from "../auth/useCloudAuth";

import { Field, TextInput, UiButton } from "./ui";

import "./AccountAvatarSettings.scss";

/** label keys in the same order as AUDIO_AVATAR_COLORS */
const COLOR_NAMES = [
  "teal",
  "blue",
  "indigo",
  "purple",
  "green",
  "olive",
  "navy",
  "slate",
] as const;

/** keeps the last character typed and upper-cases Latin letters */
export const normalizeAvatarGlyph = (value: string) => {
  const chars = Array.from(value.trim());
  return (chars[chars.length - 1] ?? "").toUpperCase();
};

export const AccountAvatarSettings = () => {
  const { user, updateAvatar } = useCloudAuth();
  const uiAppState = useUIAppState() as ReturnType<typeof useUIAppState> | null;
  const theme = uiAppState?.theme ?? THEME.LIGHT;
  const name = user?.displayName || user?.email || null;
  const saved = user?.avatar ?? null;
  const fallback = getDefaultAudioAvatar(name);
  const initial = saved ?? fallback;

  const [color, setColor] = useState(initial.color);
  const [glyph, setGlyph] = useState(
    initial.glyph === "?" ? "" : initial.glyph,
  );
  const [composing, setComposing] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  const swatchRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // follow the account when it changes elsewhere (other tab, sign-in)
  const savedKey = saved ? `${saved.color}|${saved.glyph}` : "";
  useEffect(() => {
    const next = saved ?? getDefaultAudioAvatar(name);
    setColor(next.color);
    setGlyph(next.glyph === "?" ? "" : next.glyph);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  if (!user || !updateAvatar) {
    return null;
  }

  const glyphValid = isValidAudioAvatarGlyph(glyph);
  const showGlyphError = !composing && glyph !== "" && !glyphValid;
  const preview: AudioAvatarData = {
    color,
    glyph: glyphValid ? glyph : fallback.glyph,
  };
  const dirty =
    !saved || saved.color !== color || saved.glyph !== preview.glyph;

  const save = async (avatar: AudioAvatarData | null) => {
    setStatus("saving");
    try {
      await updateAvatar(avatar);
      setStatus("saved");
    } catch (error) {
      console.error(error);
      setStatus("error");
    }
  };

  const onSwatchKeyDown = (event: React.KeyboardEvent, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
    if (!step) {
      return;
    }
    event.preventDefault();
    const next =
      (index + step + AUDIO_AVATAR_COLORS.length) % AUDIO_AVATAR_COLORS.length;
    setColor(AUDIO_AVATAR_COLORS[next]);
    setStatus("idle");
    swatchRefs.current[next]?.focus();
  };

  return (
    <div className="AccountSettingRow AccountAvatarSettings">
      <div className="AccountSettingRow__main">
        <span className="AccountSettingRow__leading">
          <AudioAvatar
            avatar={preview}
            size={32}
            theme={theme}
            label={t("cloud.avatar.preview")}
          />
        </span>
        <div className="AccountSettingRow__text">
          <span className="AccountSettingRow__title">
            {t("cloud.avatar.title")}
          </span>
          <span className="AccountSettingRow__meta">
            {t("cloud.avatar.rowHint")}
          </span>
        </div>
        <UiButton
          size="sm"
          variant="ghost"
          aria-expanded={editing}
          aria-controls={editorId}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? t("cloud.avatar.done") : t("cloud.avatar.edit")}
        </UiButton>
      </div>
      {editing && (
        <div className="AccountSettingRow__detail" id={editorId}>
          <p className="AccountSettingRow__intro">
            {t("cloud.avatar.description")}
          </p>
          <Field
            label={t("cloud.avatar.glyph")}
            hint={showGlyphError ? undefined : t("cloud.avatar.glyphHint")}
            error={showGlyphError ? t("cloud.avatar.invalid") : undefined}
          >
            <TextInput
              className="AccountAvatarSettings__glyph"
              value={glyph}
              autoComplete="off"
              spellCheck={false}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                setComposing(false);
                setGlyph(normalizeAvatarGlyph(event.currentTarget.value));
              }}
              onChange={(event) => {
                setStatus("idle");
                const { value } = event.target;
                // while an IME composes, keep the raw text so pinyin works
                setGlyph(
                  (event.nativeEvent as InputEvent).isComposing
                    ? value
                    : normalizeAvatarGlyph(value),
                );
              }}
            />
          </Field>
          <div className="UiField">
            <span className="UiField__label" id="AccountAvatarSettings-colors">
              {t("cloud.avatar.color")}
            </span>
            <div
              className="AccountAvatarSettings__swatches"
              role="radiogroup"
              aria-labelledby="AccountAvatarSettings-colors"
            >
              {AUDIO_AVATAR_COLORS.map((swatch, index) => (
                <button
                  key={swatch}
                  ref={(node) => {
                    swatchRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={swatch === color}
                  aria-label={t(`cloud.avatar.colors.${COLOR_NAMES[index]}`)}
                  tabIndex={swatch === color ? 0 : -1}
                  className={clsx("AccountAvatarSettings__swatch", {
                    "AccountAvatarSettings__swatch--selected": swatch === color,
                  })}
                  style={{ "--swatch": swatch } as React.CSSProperties}
                  onClick={() => {
                    setColor(swatch);
                    setStatus("idle");
                  }}
                  onKeyDown={(event) => onSwatchKeyDown(event, index)}
                />
              ))}
            </div>
          </div>
          <div className="AccountAvatarSettings__actions">
            <span
              className={clsx("AccountAvatarSettings__status", {
                "AccountAvatarSettings__status--error": status === "error",
              })}
              role="status"
            >
              {status === "saved"
                ? t("cloud.avatar.saved")
                : status === "error"
                ? t("cloud.avatar.saveFailed")
                : ""}
            </span>
            {saved && (
              <UiButton
                variant="ghost"
                size="sm"
                onClick={() => save(null)}
                disabled={status === "saving"}
              >
                {t("cloud.avatar.reset")}
              </UiButton>
            )}
            <UiButton
              variant="secondary"
              size="sm"
              onClick={() => save(preview)}
              loading={status === "saving"}
              disabled={!dirty || !glyphValid || composing}
            >
              {t("cloud.avatar.save")}
            </UiButton>
          </div>
        </div>
      )}
    </div>
  );
};
