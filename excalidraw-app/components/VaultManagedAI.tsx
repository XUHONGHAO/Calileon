import React from "react";

import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";
import { isInitializedImageElement } from "@excalidraw/element";

import type {
  InitializedExcalidrawImageElement,
  Ordered,
} from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getCloudBackend } from "../data/cloud";
import {
  assertVaultEgressAllowed,
  vaultEgressGuard,
} from "../data/vault/egress";

import { loadAIProxyConfig } from "../ai/proxyConfig";

import type { AiGatewayCatalogEntry } from "../data/cloud";

const getManagedGateway = () => {
  // Vault content may leave the active session only through the deployment
  // managed adapter. Ignore the ordinary AI Settings endpoint here because a
  // user-controlled gateway would otherwise become a Vault egress path.
  return getCloudBackend().ai;
};

const readText = async (response: Response) => {
  const text = await response.text();
  const chunks = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (!chunks.length) {
    try {
      const json = JSON.parse(text);
      return (
        json?.choices?.[0]?.message?.content ||
        json?.content?.map?.((item: any) => item?.text || "").join("") ||
        json?.candidates?.[0]?.content?.parts
          ?.map?.((item: any) => item?.text || "")
          .join("") ||
        ""
      );
    } catch {
      return "";
    }
  }
  return chunks
    .map((line) => {
      try {
        const json = JSON.parse(line);
        return (
          json?.choices?.[0]?.delta?.content ||
          json?.choices?.[0]?.message?.content ||
          json?.delta?.text ||
          json?.candidates?.[0]?.content?.parts?.[0]?.text ||
          ""
        );
      } catch {
        return "";
      }
    })
    .join("");
};

const getDataURLBytes = (value: string) => {
  const match = /^data:[^;,]+;base64,(.*)$/.exec(value);
  if (!match) {
    return new TextEncoder().encode(value).byteLength;
  }
  return Math.floor((match[1].length * 3) / 4);
};

const MAX_VAULT_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const requestBody = (
  route: AiGatewayCatalogEntry,
  prompt: string,
  images: string[],
  operation: "stream" | "generate",
) => {
  if (route.wireProtocol.toLowerCase().includes("anthropic")) {
    return {
      model: route.model,
      max_tokens: 4096,
      stream: operation === "stream",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((image) => {
              const match = /^data:([^;,]+);base64,(.*)$/.exec(image);
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match?.[1] || "image/png",
                  data: match?.[2] || image,
                },
              };
            }),
          ],
        },
      ],
    };
  }
  if (route.wireProtocol.toLowerCase().includes("gemini")) {
    return {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...images.map((image) => {
              const match = /^data:([^;,]+);base64,(.*)$/.exec(image);
              return {
                inline_data: {
                  mime_type: match?.[1] || "image/png",
                  data: match?.[2] || image,
                },
              };
            }),
          ],
        },
      ],
    };
  }
  return {
    model: route.model,
    stream: operation === "stream",
    messages: [
      {
        role: "user",
        content: images.length
          ? [
              { type: "text", text: prompt },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: image },
              })),
            ]
          : prompt,
      },
    ],
  };
};

export const VaultManagedAI = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const backend = getCloudBackend();
  const managedEnabled = backend.ai.isEnabled();

  const [open, setOpen] = React.useState(false);
  const [review, setReview] = React.useState(false);
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  const selectedImages = React.useMemo(() => {
    if (!open || !excalidrawAPI) {
      return [];
    }
    const state = excalidrawAPI.getAppState();
    const files = excalidrawAPI.getFiles();
    return excalidrawAPI
      .getSceneElements()
      .filter(
        (element): element is Ordered<InitializedExcalidrawImageElement> =>
          state.selectedElementIds[element.id] &&
          element.type === "image" &&
          isInitializedImageElement(element) &&
          !!files[element.fileId],
      )
      .slice(0, 3)
      .map((element) => ({
        elementId: element.id,
        dataURL: files[element.fileId].dataURL,
      }));
  }, [excalidrawAPI, open]);

  const close = () => {
    setOpen(false);
    setReview(false);
    setPrompt("");
    setError("");
  };

  const send = async () => {
    if (!excalidrawAPI || !prompt.trim()) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const user = await backend.auth.getCurrentUser();
      const gateway = getManagedGateway();
      if (!user || !gateway.isEnabled()) {
        throw new Error("Managed gateway unavailable.");
      }
      const attachmentBytes = selectedImages.reduce(
        (sum, image) => sum + getDataURLBytes(image.dataURL),
        0,
      );
      if (attachmentBytes > MAX_VAULT_ATTACHMENT_BYTES) {
        throw new Error("Selected Vault attachments are too large.");
      }
      const attachmentIds = selectedImages.map((image) => image.elementId);
      const authorization = vaultEgressGuard.issueManagedAIAuthorization({
        userId: user.id,
        prompt: prompt.trim(),
        attachmentIds,
        confirmed: true,
      });
      assertVaultEgressAllowed({
        operation: "ai",
        transport: "managed-gateway",
        authorization,
        userId: user.id,
        prompt: prompt.trim(),
        attachmentIds,
        contentAudit: false,
      });
      const capability = selectedImages.length ? "vision-agent" : "text-agent";
      const catalog = await gateway.getCatalog();
      const configuredRouteId = loadAIProxyConfig().managedRoutes[capability];
      const route =
        catalog.find(
          (entry) =>
            entry.id === configuredRouteId && entry.capability === capability,
        ) || catalog.find((entry) => entry.capability === capability);
      if (!route) {
        throw new Error("No managed Vault AI route.");
      }
      const operation = route.operations.includes("stream")
        ? "stream"
        : route.operations.includes("generate")
        ? "generate"
        : undefined;
      if (!operation) {
        throw new Error(
          "Managed Vault AI route must expose stream or generate.",
        );
      }
      const response = await gateway.invoke({
        routeId: route.id,
        operation,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          requestBody(
            route,
            prompt.trim(),
            selectedImages.map((image) => image.dataURL),
            operation,
          ),
        ),
      });
      const text = await readText(response);
      if (!text) {
        throw new Error("Empty managed response.");
      }
      const appState = excalidrawAPI.getAppState();
      const elements = convertToExcalidrawElements(
        [
          {
            type: "text",
            x: (appState.width / 2 - appState.scrollX) / appState.zoom.value,
            y: (appState.height / 2 - appState.scrollY) / appState.zoom.value,
            text,
            fontSize: 20,
          },
        ],
        { regenerateIds: true },
      );
      excalidrawAPI.updateScene({
        elements: [
          ...excalidrawAPI.getSceneElementsIncludingDeleted(),
          ...elements,
        ],
      });
      close();
    } catch {
      setError(t("ai.proxy.errors.managedGateway"));
    } finally {
      setBusy(false);
    }
  };

  if (!managedEnabled) {
    return null;
  }

  return (
    <>
      <Button onSelect={() => setOpen(true)}>
        {t("ai.proxy.managedTitle")}
      </Button>
      {open && (
        <Dialog
          title={t("ai.proxy.managedTitle")}
          onCloseRequest={close}
          size="small"
        >
          <div style={{ display: "grid", gap: "0.75rem" }}>
            {!review ? (
              <>
                <label style={{ display: "grid", gap: "0.35rem" }}>
                  <span>{t("ai.assistant.message")}</span>
                  <textarea
                    rows={5}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                  />
                </label>
                <span>
                  {t("ai.workbench.referenceImages", {
                    count: selectedImages.length,
                  })}
                </span>
                <Button
                  onSelect={() => setReview(true)}
                  disabled={!prompt.trim()}
                >
                  {t("ai.common.create")}
                </Button>
              </>
            ) : (
              <>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                  {prompt}
                </pre>
                <div style={{ display: "grid", gap: "0.5rem" }}>
                  <span>
                    {t("ai.workbench.referenceImages", {
                      count: selectedImages.length,
                    })}
                  </span>
                  {selectedImages.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "0.5rem",
                      }}
                    >
                      {selectedImages.map((image) => (
                        <img
                          key={image.elementId}
                          src={image.dataURL}
                          alt={image.elementId}
                          style={{
                            width: 64,
                            height: 64,
                            objectFit: "cover",
                            borderRadius: 4,
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
                <Button onSelect={send} disabled={busy}>
                  {t("ai.common.create")}
                </Button>
                <Button onSelect={() => setReview(false)} disabled={busy}>
                  {t("ai.common.back")}
                </Button>
              </>
            )}
            {error && <div role="alert">{error}</div>}
          </div>
        </Dialog>
      )}
    </>
  );
};
