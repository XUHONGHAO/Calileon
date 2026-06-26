export const AI_OPEN_SETTINGS_EVENT = "excalidraw:open-ai-settings";

export type AISettingsTab = "models" | "agents" | "templates";

export type AIOpenSettingsEventDetail = {
  tab?: AISettingsTab;
};

export type AIOpenSettingsEvent = CustomEvent<AIOpenSettingsEventDetail>;

export const createAIOpenSettingsEvent = (
  detail: AIOpenSettingsEventDetail,
) => {
  return new CustomEvent<AIOpenSettingsEventDetail>(AI_OPEN_SETTINGS_EVENT, {
    detail,
  });
};

declare global {
  interface WindowEventMap {
    [AI_OPEN_SETTINGS_EVENT]: AIOpenSettingsEvent;
  }
}
