/**
 * The one approved private Pi dependency in the SDK host.
 *
 * Pi 1.0.0's CLI installs its llama.cpp manager from a built-in
 * extension registry that is shipped in the package but omitted from package
 * exports. Pi-Vis loads only that registry entry, then hands the factory back
 * to Pi through DefaultResourceLoader's public `extensionFactories` option.
 *
 * Keep this adapter exact-version and exact-shape gated. A Pi upgrade must
 * re-audit this file, the compatibility ADR, and the real-router E2E test.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiEntry } from "./bootstrap.mjs";

export const PINNED_PRIVATE_LLAMA_VERSION = "1.0.0";
const LLAMA_EXTENSION_NAME = "llama.cpp";

export async function importPinnedLlamaExtension(piPath, piVersion) {
  if (piVersion !== PINNED_PRIVATE_LLAMA_VERSION) {
    throw new Error(
      `The private llama.cpp adapter is approved only for Pi ${PINNED_PRIVATE_LLAMA_VERSION}; received ${String(piVersion)}`,
    );
  }

  const publicEntry = resolvePiEntry(piPath);
  const privateBuiltInsEntry = path.join(path.dirname(publicEntry), "extensions", "index.js");
  const privateModule = await import(pathToFileURL(privateBuiltInsEntry).href);
  const matches = Array.isArray(privateModule.builtInExtensions)
    ? privateModule.builtInExtensions.filter(
        (entry) => entry && entry.name === LLAMA_EXTENSION_NAME,
      )
    : [];

  if (matches.length !== 1) {
    throw new Error(
      `Pi ${piVersion}'s private built-in registry must contain exactly one ${LLAMA_EXTENSION_NAME} extension`,
    );
  }

  const extension = matches[0];
  if (
    typeof extension.factory !== "function" ||
    extension.builtin !== true ||
    extension.hidden !== undefined ||
    extension.replaceable !== undefined
  ) {
    throw new Error(
      `Pi ${piVersion}'s private ${LLAMA_EXTENSION_NAME} extension has an unexpected shape`,
    );
  }

  // Copy only the public InlineExtension fields. Never inject the registry or
  // automatically opt in to other private built-ins added by a future Pi.
  return Object.freeze({
    name: LLAMA_EXTENSION_NAME,
    factory: extension.factory,
    builtin: true,
  });
}
