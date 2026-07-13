import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IntentLedgerModel,
  type Owner,
  PublicationModel,
} from "./fixtures/authority-publication-model.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = path.join(repositoryRoot, "src/main");
const rendererRoot = path.join(repositoryRoot, "src/renderer/src");
const hostRoot = path.join(repositoryRoot, "resources/pi-session-host");
const SOURCE_EXTENSION = /\.(?:ts|tsx|mjs)$/;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return SOURCE_EXTENSION.test(entry.name) && !entry.name.includes(".test.") ? [entryPath] : [];
  });
}

function relative(file: string): string {
  return path.relative(repositoryRoot, file);
}

function matchingLines(files: readonly string[], predicate: (line: string) => boolean): string[] {
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        predicate(line) ? [`${relative(file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Could not find ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Could not close ${signature}`);
}

const HOST_A: Owner = { hostInstanceId: "host-a", sessionEpoch: 1 };
const HOST_B: Owner = { hostInstanceId: "host-b", sessionEpoch: 2 };

/**
 * These are reference-model proofs, not implementation conformance. The
 * source gates below make the migration work explicit until the production
 * authority-frame protocol is wired.
 */
describe("state rewrite publication and intent reference model", () => {
  it("accepts only contiguous ordered publications and enters synchronizing on a gap", () => {
    for (let seed = 1; seed <= 64; seed++) {
      const model = new PublicationModel<number>();
      model.installBaseline(HOST_A, 0);
      const order = [1, 2, 3];
      let random = seed;
      for (let index = order.length - 1; index > 0; index--) {
        random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
        const swap = random % (index + 1);
        [order[index], order[swap]] = [order[swap]!, order[index]!];
      }
      for (const sequence of order) model.receive({ owner: HOST_A, sequence, value: sequence });

      const applied = model.applied.map((publication) => publication.sequence);
      expect(applied, `seed=${seed}`).toEqual(applied.map((_value, index) => index + 1));
      if (order.join(",") === "1,2,3") {
        expect(model.state, `seed=${seed}`).toBe("following");
        expect(applied).toEqual([1, 2, 3]);
      } else {
        expect(model.state, `seed=${seed}`).toBe("synchronizing");
      }
    }
  });

  it("fences predecessor publications when a successor baseline replaces the owner", () => {
    const model = new PublicationModel<string>();
    model.installBaseline(HOST_A, 3);
    expect(model.receive({ owner: HOST_A, sequence: 4, value: "old-current" })).toBe("applied");

    model.installBaseline(HOST_B, 10);
    expect(model.receive({ owner: HOST_A, sequence: 5, value: "late-predecessor" })).toBe(
      "ignored",
    );
    expect(model.receive({ owner: HOST_B, sequence: 11, value: "successor" })).toBe("applied");
    expect(model.applied.map((publication) => publication.value)).toEqual(["successor"]);
  });

  it("deduplicates identical same-owner intents and never replays an intent into another owner", () => {
    const ledger = new IntentLedgerModel();
    expect(ledger.admit(HOST_A, "intent-1", "submit:hello")).toBe("admitted");
    expect(ledger.admit(HOST_A, "intent-1", "submit:hello")).toBe("duplicate");
    expect(ledger.invocationCount("intent-1")).toBe(1);
    expect(ledger.admit(HOST_A, "intent-1", "submit:changed")).toBe("payload_conflict");
    expect(ledger.admit(HOST_B, "intent-1", "submit:hello")).toBe("cross_owner");
    expect(ledger.invocationCount("intent-1")).toBe(1);
  });

  it("installs attach baseline then replays only contiguous buffered publications above its high-water mark", () => {
    const model = new PublicationModel<string>();
    model.beginAttach(HOST_A);
    model.buffer({ owner: HOST_A, sequence: 7, value: "seven" });
    model.buffer({ owner: HOST_B, sequence: 7, value: "wrong-owner" });
    model.buffer({ owner: HOST_A, sequence: 6, value: "six" });
    model.installAttachBaseline(HOST_A, 5);

    expect(model.state).toBe("following");
    expect(model.applied.map((publication) => publication.value)).toEqual(["six", "seven"]);

    const gap = new PublicationModel<string>();
    gap.beginAttach(HOST_A);
    gap.buffer({ owner: HOST_A, sequence: 7, value: "missing-six" });
    gap.installAttachBaseline(HOST_A, 5);
    expect(gap.state).toBe("synchronizing");
    expect(gap.applied).toEqual([]);
  });
});

describe("state rewrite architectural source gates", () => {
  const rendererFiles = sourceFiles(rendererRoot);
  const mainFiles = sourceFiles(mainRoot);
  const processFiles = [...mainFiles, ...rendererFiles];

  it("keeps PiRpcCommand and command policy out of the renderer", () => {
    const forbidden = /\b(?:PiRpcCommand|PI_COMMAND_POLICY|commandPolicy|commandNeedsIntent)\b/;
    const violations = matchingLines(
      rendererFiles,
      (line) =>
        /\bimport(?:\s+type)?\s*\{/.test(line) &&
        /pi-protocol\/commands(?:\.js)?["']/.test(line) &&
        forbidden.test(line),
    );
    expect(
      violations,
      "Renderer must dispatch high-level intents only. Move PiRpcCommand and command-policy " +
        "classification to the SDK host's intent admission layer; renderer code may not import it.",
    ).toEqual([]);
  });

  it("prevents main from branching on Pi semantic liveness", () => {
    const semanticFields =
      /\b(?:isIdle|isStreaming|isCompacting|isRetrying|isBashRunning|pendingMessageCount)\b|hostFacts\.(?:submitting|actualCompaction|navigation|custodyCount)/;
    const controlExpression = /\bif\s*\(|\?|&&|\|\|/;
    const violations = matchingLines(mainFiles, (line) => {
      const code = withoutComments(line);
      return semanticFields.test(code) && controlExpression.test(code);
    });
    expect(
      violations,
      "Main may validate transport/identity/lifecycle only, not select behavior from Pi liveness. " +
        "Move this semantic branch into the SDK-host authority transaction and route its opaque frame.",
    ).toEqual([]);
  });

  it("keeps abort target selection out of renderer and main", () => {
    const abortTargets = matchingLines(processFiles, (line) =>
      /\btype\s*:\s*["']abort(?:_bash|_retry)?["']/.test(withoutComments(line)),
    );
    expect(
      abortTargets,
      "Renderer/main must dispatch one interrupt intent, never choose abort/abort_bash/abort_retry. " +
        "Move target selection to the SDK host.",
    ).toEqual([]);
  });

  it("keeps prompt-versus-queue selection out of renderer and main", () => {
    const queueDecisions = matchingLines(processFiles, (line) => {
      const code = withoutComments(line);
      return (
        /\brequestedMode\s*(?:===|!==|\?)/.test(code) ||
        /\brequestedMode\s*:\s*["'](?:steer|followUp)["']/.test(code)
      );
    });
    expect(
      queueDecisions,
      "Renderer/main may carry an intent but cannot choose prompt/steer/follow-up or reconstruct a " +
        "queue. Remove requestedMode decisions and let the SDK host publish the authoritative outcome.",
    ).toEqual([]);
  });

  it("has no generic session.sendCommand mutation pathway outside the host transport adapter", () => {
    const genericIpc = matchingLines(processFiles, (line) =>
      /["']session\.sendCommand["']/.test(withoutComments(line)),
    );
    const genericHostCalls = matchingLines(
      mainFiles.filter((file) => relative(file) !== "src/main/pi/session-host.ts"),
      (line) => /\.sendCommand\s*\(/.test(withoutComments(line)),
    );
    expect(
      [...genericIpc, ...genericHostCalls],
      "Mutations must use a typed dispatchIntent/receipt path. Delete the generic session.sendCommand " +
        "IPC channel and move each caller to an SDK-host-owned intent handler.",
    ).toEqual([]);
  });

  it("does not let transcript events mutate semantic liveness", () => {
    const store = readFileSync(path.join(rendererRoot, "stores/sessions-store.ts"), "utf8");
    const events = methodBody(store, "applyEvents: (sessionId, rawEvents) => {");
    const livenessWrite =
      /\b(?:runtimeSnapshot|availability)\s*:|\b(?:isStreaming|isIdle|isCompacting|isRetrying|isBashRunning)\s*:/;
    expect(
      livenessWrite.test(withoutComments(events)),
      "Transcript events are presentation records only. Remove the liveness write from applyEvents and " +
        "accept semantic liveness exclusively through an authoritative host snapshot/frame.",
    ).toBe(false);
  });

  it("allows Pi SDK session API imports only in the SDK host", () => {
    const sdkImport =
      /(?:from\s*["'][^"']*(?:@earendil-works\/pi-coding-agent|pi-coding-agent|\/dist\/index\.js)[^"']*["']|import\([^)]*(?:pi-coding-agent|\/dist\/index\.js))/;
    const violations = matchingLines(
      [
        ...sourceFiles(path.join(repositoryRoot, "src")),
        ...sourceFiles(path.join(repositoryRoot, "resources")),
      ],
      (line) => sdkImport.test(withoutComments(line)),
    ).filter((line) => !line.startsWith("resources/pi-session-host/"));
    expect(
      violations,
      "Only resources/pi-session-host may import Pi session APIs. Replace this import with a typed IPC " +
        "intent/query contract; main and renderer must never load the SDK.",
    ).toEqual([]);
  });
});
