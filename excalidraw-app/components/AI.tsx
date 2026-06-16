import {
  DiagramToCodePlugin,
  exportToBlob,
  getTextFromElements,
  MIME_TYPES,
  TTDDialog,
} from "@excalidraw/excalidraw";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  getDefaultTextAgent,
  getDefaultVisionAgent,
  loadAIAgentConfig,
} from "../ai/agentConfig";
import { submitTextAgent } from "../ai/textAgentAdapter";
import { generateDiagramCodeWithVisionAgent } from "../ai/visionAgentAdapter";
import { TTDIndexedDBAdapter } from "../data/TTDStorage";

export const AIComponents = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  return (
    <>
      <DiagramToCodePlugin
        generate={async ({ frame, children }) => {
          const appState = excalidrawAPI.getAppState();

          const blob = await exportToBlob({
            elements: children,
            appState: {
              ...appState,
              exportBackground: true,
              viewBackgroundColor: appState.viewBackgroundColor,
            },
            exportingFrame: frame,
            files: excalidrawAPI.getFiles(),
            mimeType: MIME_TYPES.jpg,
          });

          const dataURL = await getDataURL(blob);

          const textFromFrameChildren = getTextFromElements(children);
          const agentConfig = loadAIAgentConfig();

          return generateDiagramCodeWithVisionAgent({
            agent: getDefaultVisionAgent(agentConfig),
            texts: textFromFrameChildren,
            image: dataURL,
            theme: appState.theme,
          });
        }}
      />

      <TTDDialog
        onTextSubmit={async (props) => {
          const { onChunk, onStreamCreated, signal, messages } = props;
          const agentConfig = loadAIAgentConfig();

          const result = await submitTextAgent({
            agent: getDefaultTextAgent(agentConfig),
            messages,
            onChunk,
            onStreamCreated,
            signal,
          });

          return result;
        }}
        persistenceAdapter={TTDIndexedDBAdapter}
      />
    </>
  );
};
