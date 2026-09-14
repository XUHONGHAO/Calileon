import React from "react";
import { createRoot } from "react-dom/client";

import {
  convertToExcalidrawElements,
  Excalidraw,
  MainMenu,
} from "@excalidraw/excalidraw/index";
import {
  ExportIcon,
  MagicIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  createHttpAiGateway,
  AiGatewayHttpError,
} from "../data/cloud/HttpAiGateway";

import { createSingleFilePayload } from "./payload";
import { normalizeDevicePollIntervalSeconds } from "./devicePairing";
import { serializeRuntimeDocument } from "./html";
import { saveSingleFile, saveSingleFileAs } from "./saveSingleFile";
import { SINGLE_FILE_PAYLOAD_SCRIPT_ID, type SingleFilePayload } from "./types";
import { normalizeSingleFileName } from "./exportSingleFile";

import type { AiGatewayCatalogEntry } from "../data/cloud/types";

const normalizeSingleFileGatewayURL = (raw: string) => {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
};

const readInitialPayload = (): SingleFilePayload => {
  const node = document.getElementById(SINGLE_FILE_PAYLOAD_SCRIPT_ID);
  if (!node?.textContent) {
    throw new Error("Single-file payload is missing");
  }
  return JSON.parse(node.textContent) as SingleFilePayload;
};

const initialPayload = readInitialPayload();
const singleFileGatewayURL = normalizeSingleFileGatewayURL(
  String(import.meta.env.VITE_APP_AI_GATEWAY_URL || ""),
);

const readManagedText = async (response: Response) => {
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
      return text.trim();
    }
  }
  return chunks
    .map((chunk) => {
      try {
        const json = JSON.parse(chunk);
        return (
          json?.choices?.[0]?.delta?.content ||
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

const buildManagedTextBody = (route: AiGatewayCatalogEntry, prompt: string) => {
  if (route.wireProtocol.toLowerCase().includes("anthropic")) {
    return {
      model: route.model,
      max_tokens: 4096,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    };
  }
  if (route.wireProtocol.toLowerCase().includes("gemini")) {
    return {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    };
  }
  return {
    model: route.model,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  };
};

const RuntimeApp = () => {
  const [api, setApi] = React.useState<ExcalidrawImperativeAPI | null>(null);
  const currentHandle = React.useRef<FileSystemFileHandle | null>(null);
  const [aiOpen, setAiOpen] = React.useState(false);
  const [deviceAuthorization, setDeviceAuthorization] = React.useState<Awaited<
    ReturnType<
      ReturnType<typeof createHttpAiGateway>["createDeviceAuthorization"]
    >
  > | null>(null);
  const [deviceAccessToken, setDeviceAccessToken] = React.useState("");
  const [aiPrompt, setAiPrompt] = React.useState("");
  const [aiStatus, setAiStatus] = React.useState("");
  const [aiBusy, setAiBusy] = React.useState(false);

  const gateway = React.useMemo(
    () =>
      singleFileGatewayURL
        ? createHttpAiGateway({
            auth: { getAccessToken: async () => deviceAccessToken || null },
            baseURL: singleFileGatewayURL,
          })
        : null,
    [deviceAccessToken],
  );

  React.useEffect(() => {
    if (!gateway || !deviceAuthorization || deviceAccessToken) {
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await gateway.exchangeDeviceAuthorization(
          deviceAuthorization.deviceCode,
        );
        if (!cancelled) {
          setDeviceAccessToken(result.accessToken);
          setAiStatus(t("singleFile.ai.paired"));
        }
      } catch (error) {
        if (
          !cancelled &&
          error instanceof AiGatewayHttpError &&
          error.code === "AI_GATEWAY_DEVICE_EXPIRED"
        ) {
          setDeviceAuthorization(null);
          setAiStatus(t("singleFile.ai.expired"));
        }
        if (
          !cancelled &&
          error instanceof AiGatewayHttpError &&
          error.code === "AI_GATEWAY_UNAUTHORIZED"
        ) {
          setDeviceAuthorization(null);
          setAiStatus(t("singleFile.ai.unavailable"));
        }
      }
    };
    const timer = window.setInterval(
      poll,
      normalizeDevicePollIntervalSeconds(deviceAuthorization.intervalSeconds) *
        1000,
    );
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deviceAccessToken, deviceAuthorization, gateway]);

  const createLatestBlob = React.useCallback(() => {
    if (!api) {
      throw new Error("Editor is not ready");
    }
    const payload = createSingleFilePayload({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
      name: api.getName() || initialPayload.document.name,
      generatorVersion: initialPayload.generator.version,
      createdAt: initialPayload.createdAt,
      updatedAt: Date.now(),
    });
    return new Blob([serializeRuntimeDocument(document, payload)], {
      type: "text/html;charset=utf-8",
    });
  }, [api]);

  const filename = normalizeSingleFileName(
    api?.getName() || initialPayload.document.name,
  );

  const onSave = async () => {
    try {
      const result = await saveSingleFile({
        blob: createLatestBlob(),
        filename,
        currentHandle: currentHandle.current,
        confirmFirstOverwrite: () =>
          window.confirm(t("singleFile.firstOverwritePrompt")),
      });
      currentHandle.current = result.handle;
      api?.setToast({
        message:
          result.mode === "overwrite"
            ? t("singleFile.success.saved")
            : t("singleFile.success.savedAs"),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      api?.setToast({ message: t("singleFile.errors.saveFailed") });
    }
  };

  const onSaveAs = async () => {
    try {
      await saveSingleFileAs({ blob: createLatestBlob(), filename });
      api?.setToast({ message: t("singleFile.success.savedAs") });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      api?.setToast({ message: t("singleFile.errors.saveAsFailed") });
    }
  };

  const startDevicePairing = async () => {
    if (!gateway) {
      setAiStatus(t("singleFile.ai.unavailable"));
      return;
    }
    setAiBusy(true);
    try {
      const authorization = await gateway.createDeviceAuthorization();
      setDeviceAuthorization(authorization);
      setAiStatus(t("singleFile.ai.approveCode"));
      window.open(
        authorization.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
    } catch {
      setAiStatus(t("singleFile.ai.unavailable"));
    } finally {
      setAiBusy(false);
    }
  };

  const runManagedAI = async () => {
    const prompt = aiPrompt.trim();
    if (!gateway || !prompt || !deviceAccessToken || !api) {
      return;
    }
    setAiBusy(true);
    setAiStatus(t("singleFile.ai.generating"));
    try {
      const catalog = await gateway.getCatalog({
        accessToken: deviceAccessToken,
      });
      const route = catalog.find(
        (entry) =>
          entry.capability === "text-agent" &&
          entry.operations.includes("stream"),
      );
      if (!route) {
        throw new Error("No managed text route.");
      }
      const response = await gateway.invoke({
        routeId: route.id,
        operation: "stream",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildManagedTextBody(route, prompt)),
        accessToken: deviceAccessToken,
      });
      const text = await readManagedText(response);
      if (!text) {
        throw new Error("The managed model returned no text.");
      }
      const appState = api.getAppState();
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
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
      });
      setAiPrompt("");
      setAiStatus(t("singleFile.ai.inserted"));
    } catch (error) {
      if (
        error instanceof AiGatewayHttpError &&
        (error.code === "AI_GATEWAY_UNAUTHORIZED" ||
          error.code === "AI_GATEWAY_DEVICE_EXPIRED")
      ) {
        setDeviceAccessToken("");
        setDeviceAuthorization(null);
        setAiStatus(t("singleFile.ai.expired"));
        return;
      }
      setAiStatus(t("singleFile.ai.failed"));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <Excalidraw
      onExcalidrawAPI={setApi}
      initialData={initialPayload.scene}
      aiEnabled={false}
      isCollaborating={false}
      UIOptions={{ canvasActions: { export: {} } }}
    >
      <MainMenu>
        <MainMenu.Item
          icon={save}
          onSelect={onSave}
          data-testid="single-file-save"
        >
          {t("singleFile.save")}
        </MainMenu.Item>
        <MainMenu.Item
          icon={ExportIcon}
          onSelect={onSaveAs}
          data-testid="single-file-save-as"
        >
          {t("singleFile.saveAs")}
        </MainMenu.Item>
        {singleFileGatewayURL.startsWith("https://") && (
          <MainMenu.Item
            icon={MagicIcon}
            onSelect={() => setAiOpen(true)}
            data-testid="single-file-managed-ai"
          >
            {t("singleFile.ai.title")}
          </MainMenu.Item>
        )}
        <MainMenu.Separator />
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      {aiOpen && (
        <div
          role="dialog"
          aria-label={t("singleFile.ai.title")}
          style={{
            position: "fixed",
            inset: "auto 1rem 1rem auto",
            zIndex: 10,
            width: "min(24rem, calc(100vw - 2rem))",
            display: "grid",
            gap: "0.75rem",
            padding: "1rem",
            border: "1px solid var(--default-border-color)",
            borderRadius: "0.5rem",
            background: "var(--island-bg-color)",
            boxShadow: "var(--shadow-island)",
          }}
        >
          <strong>{t("singleFile.ai.title")}</strong>
          {!deviceAccessToken && (
            <>
              <button
                type="button"
                disabled={aiBusy}
                onClick={startDevicePairing}
              >
                {t("singleFile.ai.pair")}
              </button>
              {deviceAuthorization && (
                <code style={{ fontSize: "1.2rem", textAlign: "center" }}>
                  {deviceAuthorization.userCode}
                </code>
              )}
            </>
          )}
          {deviceAccessToken && (
            <>
              <textarea
                rows={4}
                value={aiPrompt}
                aria-label={t("singleFile.ai.prompt")}
                onChange={(event) => setAiPrompt(event.target.value)}
              />
              <button
                type="button"
                disabled={aiBusy || !aiPrompt.trim()}
                onClick={runManagedAI}
              >
                {t("singleFile.ai.generate")}
              </button>
            </>
          )}
          {aiStatus && <span role="status">{aiStatus}</span>}
          <button type="button" onClick={() => setAiOpen(false)}>
            {t("buttons.close")}
          </button>
        </div>
      )}
    </Excalidraw>
  );
};

createRoot(document.getElementById("root")!).render(<RuntimeApp />);
