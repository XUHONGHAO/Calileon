import { serializeCastScript } from "./serialization";

import type { CloudBackend } from "../data/cloud";

import type { CastScriptV1 } from "./types";

export const saveCastScriptToCloud = async (input: {
  backend: CloudBackend;
  sceneId: string;
  script: CastScriptV1;
}) => {
  const session = await input.backend.cast.createSession({
    sceneId: input.sceneId,
    title: input.script.title,
    durationMs: input.script.durationMs,
  });
  const scriptAsset = await input.backend.assets.upload({
    blob: new Blob([serializeCastScript(input.script)], {
      type: "application/json",
    }),
    type: "recording",
    sceneId: input.sceneId,
    fileId: `cast-${session.id}.calileon-cast.json`,
    mimeType: "application/json",
  });
  return input.backend.cast.attachScript(session.id, {
    scriptAssetId: scriptAsset.id,
    durationMs: input.script.durationMs,
  });
};
