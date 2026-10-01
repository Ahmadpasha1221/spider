import { describe, expect, it } from "vitest";
import { COMMANDS, EXTENSION_ID, EXTENSION_NAME } from "../../../src/shared/constants";

describe("constants", () => {
  it("exports the extension id", () => {
    expect(EXTENSION_ID).toBe("spider");
  });

  it("exports the extension display name", () => {
    expect(EXTENSION_NAME).toBe("Spider");
  });

  it("exports stable command ids", () => {
    expect(COMMANDS.openAgent).toBe("spider.openAgent");
    expect(COMMANDS.openSettings).toBe("spider.openSettings");
  });
});
