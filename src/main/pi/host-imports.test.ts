import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: the pi-session-host depends on Pi's public surface except for one
 * exact-version llama.cpp compatibility adapter.
 *
 * The host imports the bundled pinned Pi via three allowlisted targets:
 *   - pi's public entry: `dist/index.js`
 *   - public pi-tui:      `@earendil-works/pi-tui/dist/index.js`
 *   - bundled undici:     `undici/index.js`
 *
 * `pinned-pi-private.mjs` alone may derive `dist/extensions/index.js`, select
 * the private-registry `llama.cpp` factory, and return it for injection through Pi's
 * public resource-loader option. It may not deep-import llama implementation
 * files, and no other host file may reference the registry. This test makes
 * the exception auditable instead of weakening the general boundary.
 */
describe("pi-session-host import discipline", () => {
  const hostDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "resources",
    "pi-session-host",
  );
  const privateAdapter = "pinned-pi-private.mjs";
  const files = readdirSync(hostDir)
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .sort();

  // Private Pi surfaces no host file may reference, including the adapter.
  const forbidden = [
    /dist\/core\//,
    /dist\/modes\//,
    /\/core\/extensions/,
    /interactive\/theme/,
    /Symbol\.for\([^)]*theme/i,
    /globalThis\[[^\]]*theme/i,
  ];

  for (const file of files) {
    it(`${file} references no unapproved private Pi paths`, () => {
      const src = readFileSync(path.join(hostDir, file), "utf8");
      for (const pattern of forbidden) {
        expect(src, `${file} must not reference ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("isolates the private built-in registry to the pinned llama.cpp adapter", () => {
    const privateRegistryReference =
      /builtInExtensions|(?:dist\/)?extensions\/index(?:\.js)?|["'`]extensions["'`]\s*,\s*["'`]index\.js["'`]/;
    const directLlamaSubmodule =
      /(?:dist\/)?extensions\/llama(?:\/|["'`])|["'`]extensions["'`]\s*,\s*["'`]llama["'`]/;

    for (const file of files.filter((file) => file !== privateAdapter)) {
      const src = readFileSync(path.join(hostDir, file), "utf8");
      expect(src, `${file} must not inspect Pi's built-in extension registry`).not.toMatch(
        privateRegistryReference,
      );
    }
    for (const file of files) {
      const src = readFileSync(path.join(hostDir, file), "utf8");
      expect(src, `${file} must not deep-import Pi's llama implementation`).not.toMatch(
        directLlamaSubmodule,
      );
    }

    const adapter = readFileSync(path.join(hostDir, privateAdapter), "utf8");
    expect(adapter).toContain("export async function importPinnedLlamaExtension");
    expect(adapter).toMatch(
      /path\.join\(path\.dirname\(publicEntry\), "extensions", "index\.js"\)/,
    );
    expect(adapter.match(/privateModule\.builtInExtensions/g)).toHaveLength(2);
    expect(adapter).not.toMatch(/["']\.\/llama\/|["'].*extensions\/llama/);
  });
});
