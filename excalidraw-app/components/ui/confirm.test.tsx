import { vi } from "vitest";

import { confirmAction } from "./confirm";

describe("confirmAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to window.confirm when no ConfirmHost is mounted", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    await expect(confirmAction("Delete it?")).resolves.toBe(true);
    expect(confirmSpy).toHaveBeenCalledWith("Delete it?");

    confirmSpy.mockReturnValue(false);
    await expect(confirmAction("Delete it?")).resolves.toBe(false);
  });
});
