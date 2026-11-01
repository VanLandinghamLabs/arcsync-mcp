import { describe, expect, it, vi } from "vitest";

vi.mock("@auto-arch-diagram/core/authoring", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@auto-arch-diagram/core/authoring")>()),
  listIcons: () => Array.from({ length: 250 }, (_, i) => ({ id: `aws:icon-${i}`, vendor: "aws" })),
}));

const { listIconsTool } = await import("./authoringTools.js");

describe("list_icons cap", () => {
  it("shows at most 200 ids and says how many matched", async () => {
    const text = await listIconsTool.run({} as never, {});
    expect(text).toContain("aws (200):");
    expect(text).toContain("Showing 200 of 250; narrow with a query.");
  });
});
