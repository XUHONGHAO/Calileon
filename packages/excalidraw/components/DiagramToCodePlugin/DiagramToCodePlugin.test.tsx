import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DiagramToCodePlugin } from "./DiagramToCodePlugin";

const { setPlugins } = vi.hoisted(() => ({
  setPlugins: vi.fn(),
}));

vi.mock("../App", () => ({
  useApp: () => ({ setPlugins }),
}));

describe("DiagramToCodePlugin", () => {
  it("clears the registered generator when Vault mode unmounts AI components", () => {
    const generate = vi.fn();
    const { unmount } = render(<DiagramToCodePlugin generate={generate} />);

    expect(setPlugins).toHaveBeenNthCalledWith(1, {
      diagramToCode: { generate },
    });

    unmount();

    expect(setPlugins).toHaveBeenNthCalledWith(2, {
      diagramToCode: undefined,
    });
  });
});
