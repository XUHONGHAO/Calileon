import { useId, useRef, useState } from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import { toBackendError } from "../../comments/commentsController";
import { countChars, DELETE_REASON_MAX_LENGTH } from "../../comments/limits";
import {
  AppDialog,
  Callout,
  DialogActions,
  Field,
  TextArea,
  UiButton,
} from "../ui";

import type { DeleteDialogKind } from "../../comments/deletePolicy";

/**
 * Confirms a delete (technical design §11.2). The kind is the client's
 * prediction; the server decides the outcome and the feed shows the result.
 * Cancel takes the initial focus, as in `confirmAction`.
 */
export const DeleteCommentDialog = ({
  kind,
  onConfirm,
  onClose,
}: {
  kind: DeleteDialogKind;
  onConfirm: (opts: {
    reason: string | null;
    hideOriginal: boolean;
  }) => Promise<void>;
  onClose: () => void;
}) => {
  const [reason, setReason] = useState("");
  const [hideOriginal, setHideOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hideHintId = useId();
  const tooLong = countChars(reason) > DELETE_REASON_MAX_LENGTH;

  const confirm = async () => {
    if (busy || tooLong) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        reason: kind === "retract" ? null : reason.trim() || null,
        hideOriginal: kind === "owner" && hideOriginal,
      });
      onClose();
    } catch (err) {
      setError(toBackendError(err).message);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      size="small"
      title={t("comments.delete.title")}
      onCloseRequest={onClose}
      busy={busy}
      initialFocusRef={cancelRef}
      className="DeleteCommentDialog"
    >
      {kind === "retract" ? (
        <p className="DeleteCommentDialog__text">
          {t("comments.delete.retractText")}
        </p>
      ) : (
        <>
          <Field
            label={t("comments.delete.reasonLabel")}
            hint={t("comments.delete.reasonHint")}
            error={tooLong ? t("comments.errors.tooLong") : undefined}
          >
            <TextArea
              value={reason}
              rows={3}
              className="CommentsField"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {kind === "owner" && (
            <div className="DeleteCommentDialog__hide">
              <label>
                <input
                  type="checkbox"
                  checked={hideOriginal}
                  aria-describedby={hideHintId}
                  onChange={(event) => setHideOriginal(event.target.checked)}
                />
                {t("comments.delete.hideOriginal")}
              </label>
              <p id={hideHintId} className="DeleteCommentDialog__hint">
                {t("comments.delete.hideHint")}
              </p>
            </div>
          )}
        </>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <DialogActions>
        <UiButton ref={cancelRef} onClick={onClose} disabled={busy}>
          {t("buttons.cancel")}
        </UiButton>
        <UiButton
          variant="danger"
          onClick={() => void confirm()}
          loading={busy}
          disabled={tooLong}
        >
          {t("comments.delete.confirm")}
        </UiButton>
      </DialogActions>
    </AppDialog>
  );
};
