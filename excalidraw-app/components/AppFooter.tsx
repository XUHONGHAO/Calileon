import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { isExcalidrawPlusSignedUser } from "../app_constants";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";
import { ShelfLifeStrip } from "./labs/shelfLife/ShelfLifeStrip";

export const AppFooter = React.memo(
  ({
    onChange,
    excalidrawAPI = null,
  }: {
    onChange: () => void;
    excalidrawAPI?: ExcalidrawImperativeAPI | null;
  }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
        </div>
        <ShelfLifeStrip excalidrawAPI={excalidrawAPI} />
      </Footer>
    );
  },
);
