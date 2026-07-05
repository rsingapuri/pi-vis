import { describe, expect, it } from "vitest";
import { getSyncedSpinnerStyle } from "./Spinner.js";

describe("getSyncedSpinnerStyle", () => {
  it("returns a negative delay matching the shared 800ms spinner phase", () => {
    expect(getSyncedSpinnerStyle(0)["--spinner-sync-delay"]).toBe("0ms");
    expect(getSyncedSpinnerStyle(250)["--spinner-sync-delay"]).toBe("-250ms");
    expect(getSyncedSpinnerStyle(1050)["--spinner-sync-delay"]).toBe("-250ms");
  });
});
