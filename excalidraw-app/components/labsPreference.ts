import { useCallback, useState } from "react";

import { STORAGE_KEYS } from "../app_constants";

/** Whether the main menu shows the Labs (experimental) submenu. Default on. */
export const readShowLabs = () => {
  try {
    return localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_SHOW_LABS) !== "0";
  } catch {
    return true;
  }
};

export const useShowLabs = () => {
  const [showLabs, setShowLabsState] = useState(readShowLabs);
  const setShowLabs = useCallback((next: boolean) => {
    setShowLabsState(next);
    try {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_SHOW_LABS,
        next ? "1" : "0",
      );
    } catch {
      // storage unavailable: keep the in-memory choice for this session
    }
  }, []);
  return [showLabs, setShowLabs] as const;
};
