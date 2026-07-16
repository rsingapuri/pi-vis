import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/invariants.mjs";
import {
  REAL_SDK_PROVIDER_LATENCY,
  type RealSdkFixture,
  type RealSdkFixtureOptions,
  type RealSdkLaunch,
  assertValidSessionJsonl,
  createRealSdkFixture,
  killRealSdkHost,
  openNewRealSession,
  replaceRealSdkHost,
  selectLocalTestModel,
} from "./support/real-sdk-host.mjs";
import { createScriptedOpenAIProvider } from "./support/scripted-openai-provider.mjs";

const LIFECYCLE_EXTENSION = join(
  import.meta.dirname,
  "../fixtures/real-host-lifecycle-extension/lifecycle-e2e.ts",
);

type FaultRule = {
  action: "drop" | "duplicate" | "delay" | "reorder";
  match: { type: string; plane?: string; nth?: number };
  delayMs?: number;
};
type FaultPlan = {
  inbound?: FaultRule[];
  outbound?: FaultRule[];
};
type Owner = { hostInstanceId: string; sessionEpoch: number };
type AttachResponse = {
  status: string;
  baseline?: {
    rendererGeneration: number;
    owner: Owner;
    semantic?: {
      snapshot?: { operationJournalLowWatermark?: number; operationJournalHighWatermark?: number };
    };
    operationJournal?: Array<{ sequence?: number }>;
  };
};
type IpcEntry = { channel?: string; payload?: { sessionId?: string; rendererGeneration?: number } };
type PivisBridge = { invoke(channel: string, args: unknown): Promise<unknown> };

const PLANS: Record<string, FaultPlan> = {
  drop: {
    inbound: [
      {
        action: "drop",
        match: { type: "authority_publication", plane: "extensionUi", nth: 1 },
      },
    ],
  },
  reorder: {
    inbound: [
      {
        action: "reorder",
        match: { type: "authority_publication", plane: "extensionUi", nth: 1 },
      },
    ],
  },
  duplicate: {
    inbound: [
      {
        action: "duplicate",
        match: { type: "authority_publication", plane: "extensionUi", nth: 1 },
      },
    ],
  },
  overflow: {
    outbound: [{ action: "delay", match: { type: "authority_attach", nth: 2 }, delayMs: 350 }],
  },
  replacement: {
    outbound: [{ action: "delay", match: { type: "authority_attach", nth: 3 }, delayMs: 350 }],
  },
  compactionDetach: {
    outbound: [{ action: "delay", match: { type: "renderer_detached", nth: 1 }, delayMs: 300 }],
  },
};

const readLog = (file: string): IpcEntry[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as IpcEntry] : [];
      } catch {
        return [];
      }
    });
};

async function invoke(page: Page, channel: string, args: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ channel, args }) =>
      (window as unknown as { pivis: PivisBridge }).pivis.invoke(channel, args),
    { channel, args },
  );
}

async function slash(textarea: Locator, command: string): Promise<void> {
  await textarea.fill(command);
  // Pi's completion menu owns Enter while it is visible; Escape makes this a
  // real command dispatch rather than a timing-sensitive completion choice.
  await textarea.press("Escape");
  await textarea.press("Enter");
  await expect(textarea).toHaveValue("");
}

async function waitForFixtureIdentity(
  logFile: string,
): Promise<{ sessionId: string; generation: number }> {
  await expect
    .poll(
      () => {
        const entries = readLog(logFile);
        const sessionId = entries.find((entry) => entry.channel === "session.activate")?.payload
          ?.sessionId;
        const generation = entries.find((entry) => entry.channel === "session.authorityAttach")
          ?.payload?.rendererGeneration;
        return sessionId && generation && generation > 0 ? { sessionId, generation } : undefined;
      },
      { timeout: 30_000 },
    )
    .toBeTruthy();
  const entries = readLog(logFile);
  const sessionId = entries.find((entry) => entry.channel === "session.activate")?.payload
    ?.sessionId;
  const generation = entries.find((entry) => entry.channel === "session.authorityAttach")?.payload
    ?.rendererGeneration;
  if (!sessionId || !generation)
    throw new Error("real authority startup did not produce an IPC identity");
  return { sessionId, generation };
}

async function attach(page: Page, sessionId: string, generation: number): Promise<AttachResponse> {
  return (await invoke(page, "session.authorityAttach", {
    sessionId,
    rendererGeneration: generation,
  })) as AttachResponse;
}

async function readyAttach(
  page: Page,
  sessionId: string,
  generation: number,
): Promise<AttachResponse> {
  let latest: AttachResponse | undefined;
  await expect
    .poll(
      async () => {
        latest = await attach(page, sessionId, generation);
        return latest.status;
      },
      { timeout: 30_000 },
    )
    .toBe("ready");
  if (!latest?.baseline) throw new Error("ready authority attach omitted its baseline");
  return latest;
}

async function installPublicationJournal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __authorityPublications?: unknown[] };
    target.__authorityPublications = [];
    window.pivis.on("session.publication", (publication) =>
      target.__authorityPublications?.push(publication),
    );
  });
}

async function publicationOwners(page: Page): Promise<Owner[]> {
  return page.evaluate(() => {
    const events =
      (window as unknown as { __authorityPublications?: unknown[] }).__authorityPublications ?? [];
    return events.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const owner = (event as { owner?: unknown }).owner;
      if (!owner || typeof owner !== "object") return [];
      const candidate = owner as { hostInstanceId?: unknown; sessionEpoch?: unknown };
      return typeof candidate.hostInstanceId === "string" &&
        typeof candidate.sessionEpoch === "number"
        ? [{ hostInstanceId: candidate.hostInstanceId, sessionEpoch: candidate.sessionEpoch }]
        : [];
    });
  });
}

async function withFault(
  plan: FaultPlan,
  run: (
    fixture: RealSdkFixture,
    launch: RealSdkLaunch,
    sessionId: string,
    generation: number,
    logFile: string,
  ) => Promise<void>,
  options: Omit<RealSdkFixtureOptions, "faultPlan" | "ipcInvocationLog"> = {},
): Promise<void> {
  const directory = fs.mkdtempSync(join(os.tmpdir(), "pivis-authority-fault-"));
  const logFile = join(directory, "ipc.jsonl");
  fs.writeFileSync(logFile, "");
  const fixture = createRealSdkFixture({
    ...options,
    faultPlan: plan,
    ipcInvocationLog: logFile,
    realHostControl: true,
    extensionFiles: options.extensionFiles ?? [LIFECYCLE_EXTENSION],
  });
  let launch: RealSdkLaunch | undefined;
  try {
    launch = await fixture.launch();
    await openNewRealSession(launch.window);
    const { sessionId, generation } = await waitForFixtureIdentity(logFile);
    await installPublicationJournal(launch.window);
    await run(fixture, launch, sessionId, generation, logFile);
  } catch (error) {
    throw new Error(
      `${String(error)}\n${await fixture.diagnostics(launch?.window)}\nElectron output:\n${launch?.output.join("") ?? "<none>"}`,
    );
  } finally {
    // A test that deliberately SIGKILLs a host may leave CDP waiting for the
    // app's restart supervisor. Bound teardown without changing app behavior.
    await Promise.race([
      launch?.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    fixture.cleanup();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function expectOwner(owner: Owner | undefined): asserts owner is Owner {
  if (!owner?.hostInstanceId || !Number.isInteger(owner.sessionEpoch))
    throw new Error("missing authority owner");
}

test.describe("real Pi authority fault matrix", () => {
  for (const [name, plan] of Object.entries({
    drop: PLANS.drop,
    reorder: PLANS.reorder,
    duplicate: PLANS.duplicate,
  })) {
    test(`${name} presentation traffic converges from an owner-bound baseline`, async () => {
      test.setTimeout(90_000);
      await withFault(plan, async (_fixture, launch, sessionId, generation, logFile) => {
        const textarea = launch.window.locator(".composer__textarea");
        const status = launch.window
          .locator(".statusbar__line")
          .filter({ hasText: "e2e lifecycle status enabled" });
        const attachCount = () =>
          readLog(logFile).filter((entry) => entry.channel === "session.authorityAttach").length;
        const before = attachCount();

        await slash(textarea, "/e2e-status-on");
        if (name === "duplicate") {
          // A duplicate source sequence is discarded by main. It must neither
          // be applied twice nor start a baseline storm.
          await expect(status).toHaveCount(1);
        }
        await slash(textarea, "/e2e-status-off");

        if (name === "drop" || name === "reorder") {
          // A missing/out-of-order extension-UI cursor fences that plane and
          // makes App request a serialized baseline before it can converge.
          await expect.poll(attachCount, { timeout: 30_000 }).toBeGreaterThan(before);
        } else {
          await expect(status).toHaveCount(0);
          expect(attachCount()).toBe(before);
          const sequences = await launch.window.evaluate(() =>
            (
              (
                window as unknown as {
                  __authorityPublications?: Array<{ publicationSequence?: number }>;
                }
              ).__authorityPublications ?? []
            ).flatMap((publication) =>
              typeof publication.publicationSequence === "number"
                ? [publication.publicationSequence]
                : [],
            ),
          );
          expect(new Set(sequences).size).toBe(sequences.length);
        }

        const response = await readyAttach(launch.window, sessionId, generation);
        expectOwner(response.baseline?.owner);
        await expect(status).toHaveCount(0);
        expect(attachCount()).toBeLessThanOrEqual(before + 4);
        const owners = await publicationOwners(launch.window);
        expect(
          owners.every((owner) => owner.hostInstanceId === response.baseline!.owner.hostInstanceId),
        ).toBe(true);
      });
    });
  }

  test("bounded overflow abandons the partial tail and converges by a fresh attach", async () => {
    test.setTimeout(90_000);
    await withFault(
      PLANS.overflow,
      async (_fixture, launch, sessionId, generation, logFile) => {
        const attaching = attach(launch.window, sessionId, generation);
        const textarea = launch.window.locator(".composer__textarea");
        await slash(textarea, "/e2e-status-on");
        await slash(textarea, "/e2e-status-off");
        await attaching.catch(() => undefined);
        const response = await readyAttach(launch.window, sessionId, generation);
        expectOwner(response.baseline?.owner);
        await expect(
          launch.window
            .locator(".statusbar__line")
            .filter({ hasText: "e2e lifecycle status enabled" }),
        ).toHaveCount(0);
        // The log is an IPC assertion: recovery has a finite attach budget,
        // rather than an unbounded attach/focus retry loop.
        expect(
          readLog(logFile).filter((entry) => entry.channel === "session.authorityAttach").length,
        ).toBeLessThanOrEqual(7);
      },
      // The fault seam is deliberately fixed at the production test boundary:
      // exactly four buffered publications may survive before recovery must
      // abandon the tail and fetch an authoritative baseline.
      { authorityBufferLimit: 4 },
    );
  });

  test("a delayed attach racing /new admits only the successor and never replays predecessor publications", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { model: "pivis-test-model", promptIncludes: "authority replacement seed" },
          response: { type: "text", chunks: ["AUTHORITY-REPLACEMENT-SEED"] },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    try {
      await withFault(
        PLANS.replacement,
        async (_fixture, launch, sessionId, generation) => {
          const textarea = launch.window.locator(".composer__textarea");
          await selectLocalTestModel(launch.window, textarea);
          await textarea.fill("authority replacement seed");
          await textarea.press("Enter");
          await expect(
            launch.window.getByText("AUTHORITY-REPLACEMENT-SEED", { exact: true }),
          ).toBeVisible({ timeout: 60_000 });
          await slash(textarea, "/e2e-status-on");
          const predecessor = await readyAttach(launch.window, sessionId, generation);
          expectOwner(predecessor.baseline?.owner);
          // Hold a real authority-attach response while the deterministic
          // child-owned replacement seam commits its successor. This is the
          // same lifecycle boundary as /new, but avoids timing an SDK UI
          // command against an attach response.
          // Attach rejection is expected when the delayed predecessor reply is
          // fenced by its replacement; catch immediately so Playwright does
          // not treat that intentional rejection as an unhandled test error.
          const racing = attach(launch.window, sessionId, generation).catch(() => undefined);
          const replacement = await replaceRealSdkHost(launch, sessionId);
          expect(replacement.status).toBe("replacement");
          expectOwner(replacement.owner);
          await racing.catch(() => undefined);
          let successor: AttachResponse | undefined;
          await expect
            .poll(
              async () => {
                const candidate = await attach(launch.window, sessionId, generation);
                if (candidate.status === "ready" && candidate.baseline) successor = candidate;
                return successor?.baseline?.owner.sessionEpoch;
              },
              { timeout: 60_000 },
            )
            .toBeGreaterThan(predecessor.baseline.owner.sessionEpoch);
          expectOwner(successor?.baseline?.owner);
          // A /reload-style successor keeps the process id but must advance
          // the epoch; the owner tuple, rather than only hostInstanceId, is
          // the no-bleed boundary.
          expect(successor!.baseline!.owner.sessionEpoch).toBeGreaterThan(
            predecessor.baseline.owner.sessionEpoch,
          );
          // The old extension-owned status must not bleed through the replacement.
          await expect(
            launch.window
              .locator(".statusbar__line")
              .filter({ hasText: "e2e lifecycle status enabled" }),
          ).toHaveCount(0);
          // The renderer reducer rejects any late predecessor publication by
          // this owner tuple; the successor baseline plus absent predecessor
          // status above prove no old presentation was applied.
        },
        { providerBaseUrl: provider.baseUrl },
      );
      provider.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  test("reload while gated real compaction is active converges journal and watermarks", async () => {
    test.setTimeout(240_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "authority compact seed one", compaction: false },
          response: { type: "text", chunks: ["AUTHORITY-SEED-ONE"] },
        },
        {
          expect: { promptIncludes: "authority compact seed two", compaction: false },
          response: { type: "text", chunks: ["AUTHORITY-SEED-TWO"] },
        },
        {
          expect: { compaction: { includes: "authority compact seed one" } },
          response: { type: "text", chunks: ["AUTHORITY-COMPACTION-SUMMARY"], gate: "compact" },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    try {
      await withFault(
        PLANS.compactionDetach,
        async (fixture, launch, sessionId, generation, logFile) => {
          const textarea = launch.window.locator(".composer__textarea");
          await selectLocalTestModel(launch.window, textarea);
          for (const seed of ["authority compact seed one", "authority compact seed two"]) {
            await textarea.fill(`${seed} ${"token ".repeat(250)}`);
            await textarea.press("Enter");
            await expect(
              launch.window.getByText(
                seed === "authority compact seed one" ? "AUTHORITY-SEED-ONE" : "AUTHORITY-SEED-TWO",
                { exact: true },
              ),
            ).toBeVisible({ timeout: 60_000 });
          }
          await textarea.fill("/compact");
          await textarea.press("Enter");
          await provider.waitForRequestCount(3);
          await expect(textarea).toHaveValue("");
          await launch.window.reload();
          await expect(launch.window.locator(".composer__textarea")).toBeEnabled({
            timeout: 60_000,
          });
          provider.releaseGate("compact");
          await expect
            .poll(() =>
              fixture
                .sessionFiles()
                .some((file) =>
                  fs.readFileSync(file, "utf8").includes("AUTHORITY-COMPACTION-SUMMARY"),
                ),
            )
            .toBe(true);
          assertValidSessionJsonl(fixture.sessionFiles());
          await expect
            .poll(
              () =>
                readLog(logFile)
                  .filter((entry) => entry.channel === "session.authorityAttach")
                  .at(-1)?.payload?.rendererGeneration,
              { timeout: 30_000 },
            )
            .not.toBe(generation);
          const freshGeneration = readLog(logFile)
            .filter((entry) => entry.channel === "session.authorityAttach")
            .at(-1)?.payload?.rendererGeneration;
          if (!freshGeneration) throw new Error("reload did not make a fresh authority attach");
          const baseline = await readyAttach(launch.window, sessionId, freshGeneration);
          const low = baseline.baseline!.semantic?.snapshot?.operationJournalLowWatermark;
          const high = baseline.baseline!.semantic?.snapshot?.operationJournalHighWatermark;
          const journal = baseline.baseline!.operationJournal ?? [];
          expect(typeof low).toBe("number");
          expect(typeof high).toBe("number");
          expect(
            journal.every(
              (entry, index) =>
                typeof entry.sequence === "number" &&
                entry.sequence >= low! &&
                entry.sequence <= high! &&
                (index === 0 || entry.sequence > journal[index - 1]!.sequence!),
            ),
          ).toBe(true);
          await expect(launch.window.locator(".working-row, .status-dot--streaming")).toHaveCount(
            0,
          );
          expect(provider.requests).toHaveLength(3);
        },
        { providerBaseUrl: provider.baseUrl, compactionEnabled: false },
      );
      provider.assertExhausted();
    } finally {
      await provider.close();
    }
  });

  test("post-dispatch host kill rejects duplicate replay and reaches the provider exactly once", async () => {
    test.setTimeout(180_000);
    const provider = await createScriptedOpenAIProvider(
      [
        {
          expect: { promptIncludes: "kill-after-dispatch-once", compaction: false },
          response: { type: "text", chunks: ["must never settle"], gate: "held" },
        },
      ],
      { latency: REAL_SDK_PROVIDER_LATENCY },
    );
    try {
      await withFault(
        {},
        async (_fixture, launch, sessionId, _generation, logFile) => {
          const textarea = launch.window.locator(".composer__textarea");
          await selectLocalTestModel(launch.window, textarea);
          const dispatchesBefore = readLog(logFile).filter(
            (entry) => entry.channel === "session.dispatchIntent",
          ).length;
          // Use the real composer for the admission that reaches the provider.
          // The main IPC journal then captures its exact owner-bound envelope
          // for the post-kill duplicate attempt below.
          await textarea.fill("kill-after-dispatch-once");
          await textarea.press("Enter");
          await expect.poll(() => provider.requests.length, { timeout: 30_000 }).toBe(1);
          const envelope = readLog(logFile)
            .filter((entry) => entry.channel === "session.dispatchIntent")
            .slice(dispatchesBefore)
            .map((entry) => entry.payload)
            .find(
              (payload) =>
                typeof payload === "object" &&
                payload !== null &&
                JSON.stringify(payload).includes("kill-after-dispatch-once"),
            );
          if (!envelope) throw new Error("real composer dispatch was absent from the IPC journal");
          const kill = await Promise.race([
            killRealSdkHost(launch, sessionId),
            new Promise<{ status: "timeout" }>((resolve) =>
              setTimeout(() => resolve({ status: "timeout" }), 15_000),
            ),
          ]);
          expect(["restarted", "terminal"]).toContain(kill.status);
          // Attempt the exact real-composer envelope after its owning child
          // died. Transport can reject it, but it must neither auto-replay nor
          // reach the provider a second time.
          void invoke(launch.window, "session.dispatchIntent", envelope).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          expect(provider.requests).toHaveLength(1);
          expect(provider.unexpectedRequests).toEqual([]);
        },
        { providerBaseUrl: provider.baseUrl },
      );
      provider.assertExhausted();
    } finally {
      await provider.close();
    }
  });
});
