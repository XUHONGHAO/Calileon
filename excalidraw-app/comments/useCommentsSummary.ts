/**
 * "Summarize by timeline" (ADR 0037 §9, technical design §12): the daily
 * data-sharing notice, then one streamed `submitTextAgent` call. The result
 * lives only in this hook's state; nothing is saved.
 */

import { t } from "@excalidraw/excalidraw/i18n";
import { useCallback, useEffect, useRef, useState } from "react";

import { getDefaultTextAgent, loadAIAgentConfig } from "../ai/agentConfig";
import { loadAIProxyConfig } from "../ai/proxyConfig";
import { submitTextAgent } from "../ai/textAgentAdapter";
import { confirmAction } from "../components/ui";

import {
  buildSummaryPrompt,
  needsSummaryDisclosure,
  rememberSummaryDisclosure,
} from "./aiSummary";
import { getViewerTimeZone } from "./feed";

import type { AIAgent } from "../ai/types";
import type { SceneComment } from "../data/cloud/types";

export type CommentsSummaryState = {
  status: "idle" | "running" | "done" | "stopped" | "error";
  text: string;
  error: string | null;
  included: number;
  total: number;
};

const IDLE: CommentsSummaryState = {
  status: "idle",
  text: "",
  error: null,
  included: 0,
  total: 0,
};

const getStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isAbortError = (error: Error) =>
  error.name === "AbortError" ||
  (error as Error & { status?: number }).status === 499;

/**
 * The agent that carries the summary's system prompt. In managed mode the
 * gateway route decides provider and model; the stub only carries the prompt.
 */
const getSummaryAgent = (
  systemPrompt: string,
): { agent: AIAgent | null; blocker: string | null } => {
  const transport = loadAIProxyConfig();
  const configured = getDefaultTextAgent(loadAIAgentConfig());
  if (transport.mode === "managed-gateway") {
    if (!transport.managedRoutes["text-agent"]) {
      return { agent: null, blocker: t("comments.summary.noRoute") };
    }
    return {
      agent: configured
        ? { ...configured, systemPrompt }
        : {
            id: "comments-summary",
            name: "Comments summary",
            type: "text",
            provider: "openai",
            baseURL: "",
            apiKey: "",
            model: "",
            systemPrompt,
          },
      blocker: null,
    };
  }
  if (!configured) {
    return { agent: null, blocker: t("comments.summary.noAgent") };
  }
  return { agent: { ...configured, systemPrompt }, blocker: null };
};

export const useCommentsSummary = (langCode: string) => {
  const [state, setState] = useState<CommentsSummaryState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const run = useCallback(
    async (comments: Iterable<SceneComment>) => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      const timeZone = getViewerTimeZone();
      const prompt = buildSummaryPrompt({ comments, timeZone, langCode });
      if (!prompt) {
        setState({
          ...IDLE,
          status: "error",
          error: t("comments.summary.noComments"),
        });
        return;
      }
      const { agent, blocker } = getSummaryAgent(prompt.system);
      if (blocker) {
        setState({ ...IDLE, status: "error", error: blocker });
        return;
      }
      const storage = getStorage();
      if (!storage || needsSummaryDisclosure(storage, Date.now(), timeZone)) {
        const confirmed = await confirmAction(
          t("comments.summary.disclosure"),
          {
            title: t("comments.summary.disclosureTitle"),
            confirmLabel: t("comments.summary.disclosureConfirm"),
            danger: false,
          },
        );
        if (!confirmed) {
          return;
        }
        if (storage) {
          rememberSummaryDisclosure(storage, Date.now(), timeZone);
        }
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      let text = "";
      setState({
        ...IDLE,
        status: "running",
        included: prompt.included,
        total: prompt.total,
      });
      const result = await submitTextAgent({
        agent,
        messages: [{ role: "user", content: prompt.user }],
        signal: controller.signal,
        onChunk: (chunk) => {
          if (controllerRef.current !== controller) {
            return;
          }
          text += chunk;
          setState((current) => ({ ...current, text }));
        },
      });
      if (controllerRef.current !== controller) {
        // closed, restarted or unmounted meanwhile
        return;
      }
      controllerRef.current = null;
      if (result.error) {
        const stopped = controller.signal.aborted || isAbortError(result.error);
        setState((current) => ({
          ...current,
          status: stopped ? "stopped" : "error",
          error: stopped ? null : result.error.message,
        }));
        return;
      }
      setState((current) => ({
        ...current,
        status: "done",
        // the streamed text is the answer; `generatedResponse` went through
        // the Mermaid cleanup meant for the assistant chat
        text: text || result.generatedResponse,
      }));
    },
    [langCode],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const close = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState(IDLE);
  }, []);

  return { state, run, stop, close };
};
