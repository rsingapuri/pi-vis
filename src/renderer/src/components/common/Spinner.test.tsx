import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Spinner, getSyncedSpinnerStyle } from "./Spinner.js";

describe("Spinner", () => {
  it("renders the shared five-spoke rotor", () => {
    const markup = renderToStaticMarkup(<Spinner aria-label="Working" />);

    expect(markup).toContain('class="spinner"');
    expect(markup).toContain('class="icon spinner__rotor"');
    expect(markup.match(/M6 6/g)).toHaveLength(5);
  });

  it("returns a negative delay matching the shared 3.2s rotor phase", () => {
    expect(getSyncedSpinnerStyle(0)["--spinner-sync-delay"]).toBe("0ms");
    expect(getSyncedSpinnerStyle(250)["--spinner-sync-delay"]).toBe("-250ms");
    expect(getSyncedSpinnerStyle(3450)["--spinner-sync-delay"]).toBe("-250ms");
  });
});
