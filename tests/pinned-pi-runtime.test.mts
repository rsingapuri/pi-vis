import fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import installedPiPackage from "../node_modules/@earendil-works/pi-coding-agent/package.json";
import projectPackage from "../package.json";

const PINNED_PI_VERSION = "0.80.10";

describe("test-only real Pi runtime pin", () => {
  it("keeps the manifest, installed package, and executable layout pinned exactly", () => {
    expect(projectPackage.devDependencies["@earendil-works/pi-coding-agent"]).toBe(
      PINNED_PI_VERSION,
    );
    expect(installedPiPackage.version).toBe(PINNED_PI_VERSION);
    expect(
      fs.existsSync(
        join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      ),
    ).toBe(true);
  });
});
