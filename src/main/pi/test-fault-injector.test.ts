import { afterEach, describe, expect, it, vi } from "vitest";
import { TestFaultInjector } from "./test-fault-injector.js";

const originalPlan = process.env.PIVIS_TEST_FAULT_PLAN;

afterEach(() => {
  if (originalPlan === undefined) delete process.env.PIVIS_TEST_FAULT_PLAN;
  else process.env.PIVIS_TEST_FAULT_PLAN = originalPlan;
  vi.useRealTimers();
});

function injector(plan: unknown): TestFaultInjector {
  process.env.PIVIS_TEST_FAULT_PLAN = JSON.stringify(plan);
  return TestFaultInjector.fromEnvironment();
}

describe("TestFaultInjector", () => {
  it("is a no-op when no JSON test plan is set", () => {
    delete process.env.PIVIS_TEST_FAULT_PLAN;
    const deliver = vi.fn();

    TestFaultInjector.fromEnvironment().inbound({ type: "event" }, deliver);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("matches type, nested publication plane, and nth deterministically", () => {
    const faults = injector({
      inbound: [{ action: "drop", type: "authority_publication", plane: "panel", nth: 2 }],
    });
    const deliver = vi.fn();

    faults.inbound({ type: "authority_publication", publication: { plane: "panel" } }, deliver);
    faults.inbound(
      { type: "authority_publication", publication: { plane: "transcript" } },
      deliver,
    );
    faults.inbound({ type: "authority_publication", publication: { plane: "panel" } }, deliver);

    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("parses the binding rule format with a nested match selector", () => {
    const faults = injector({
      inbound: [
        {
          match: { type: "authority_publication", plane: "panel", nth: 2 },
          action: "drop",
        },
      ],
    });
    const deliver = vi.fn();

    faults.inbound({ type: "authority_publication", plane: "panel" }, deliver);
    faults.inbound({ type: "authority_publication", plane: "panel" }, deliver);

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("duplicates outbound traffic", () => {
    const faults = injector([{ direction: "outbound", action: "duplicate", type: "command" }]);
    const delivered: unknown[] = [];
    const message = { type: "command", id: "one" };

    faults.outbound(message, () => delivered.push(message));

    expect(delivered).toEqual([message, message]);
  });

  it("delays only the selected matching message", () => {
    vi.useFakeTimers();
    const faults = injector({
      outbound: [{ action: "delay", type: "state_request", nth: 2, delayMs: 25 }],
    });
    const delivered: string[] = [];

    faults.outbound({ type: "state_request" }, () => delivered.push("first"));
    faults.outbound({ type: "state_request" }, () => delivered.push("second"));

    expect(delivered).toEqual(["first"]);
    vi.advanceTimersByTime(25);
    expect(delivered).toEqual(["first", "second"]);
  });

  it("reorders a selected message with the next matching frame", () => {
    const faults = injector({
      inbound: [{ action: "reorder", type: "event", nth: 1 }],
    });
    const delivered: string[] = [];

    faults.inbound({ type: "event", label: "first" }, () => delivered.push("first"));
    faults.inbound({ type: "event", label: "second" }, () => delivered.push("second"));

    expect(delivered).toEqual(["second", "first"]);
  });

  it("holds a reordered message through unrelated traffic", () => {
    const faults = injector({
      inbound: [
        {
          match: { type: "authority_publication", plane: "panel", nth: 1 },
          action: "reorder",
        },
      ],
    });
    const delivered: string[] = [];

    faults.inbound({ type: "authority_publication", publication: { plane: "panel" } }, () =>
      delivered.push("first"),
    );
    faults.inbound({ type: "response" }, () => delivered.push("unrelated"));
    faults.inbound({ type: "authority_publication", publication: { plane: "panel" } }, () =>
      delivered.push("successor"),
    );

    expect(delivered).toEqual(["unrelated", "successor", "first"]);
  });
});
