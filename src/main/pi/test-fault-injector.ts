/*
 * Test-only child-IPC fault injection.
 *
 * `PIVIS_TEST_FAULT_PLAN` is deliberately the sole activation switch.  A
 * missing or malformed plan produces a no-op injector, keeping normal child
 * IPC exactly as it was.
 */

export type FaultDirection = "inbound" | "outbound";
type FaultAction = "drop" | "duplicate" | "delay" | "reorder";

interface FaultRule {
  direction: FaultDirection;
  action: FaultAction;
  type: string;
  plane?: string;
  nth?: number;
  delayMs: number;
  seen: number;
}

interface DeferredDelivery {
  rule: FaultRule;
  deliver: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function actionFor(value: Record<string, unknown>): FaultAction | null {
  const action = value.action ?? value.effect ?? value.op;
  return action === "drop" || action === "duplicate" || action === "delay" || action === "reorder"
    ? action
    : null;
}

function selectorFrom(value: unknown): Pick<FaultRule, "type" | "plane" | "nth"> | null {
  const selector = asRecord(value);
  if (!selector || typeof selector.type !== "string") return null;
  const nth = selector.nth;
  if (nth !== undefined && (typeof nth !== "number" || !Number.isSafeInteger(nth) || nth < 1))
    return null;
  if (selector.plane !== undefined && typeof selector.plane !== "string") return null;
  return {
    type: selector.type,
    ...(typeof selector.plane === "string" ? { plane: selector.plane } : {}),
    ...(nth === undefined ? {} : { nth }),
  };
}

function ruleFrom(value: unknown, defaultDirection?: FaultDirection): FaultRule | null {
  const record = asRecord(value);
  if (!record) return null;
  const bindingFormat = record.match !== undefined;
  const selector = selectorFrom(bindingFormat ? record.match : record);
  if (!selector) return null;
  const direction = record.direction ?? record.dir ?? defaultDirection;
  if (direction !== "inbound" && direction !== "outbound") return null;
  const action = bindingFormat
    ? record.action === "drop" ||
      record.action === "duplicate" ||
      record.action === "delay" ||
      record.action === "reorder"
      ? record.action
      : null
    : actionFor(record);
  if (!action) return null;
  const delay = bindingFormat ? record.delayMs : (record.delayMs ?? record.delay ?? record.ms);
  if (
    bindingFormat &&
    delay !== undefined &&
    (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)
  )
    return null;
  return {
    direction,
    action,
    ...selector,
    delayMs: typeof delay === "number" && Number.isFinite(delay) && delay >= 0 ? delay : 0,
    seen: 0,
  };
}

function appendRules(target: FaultRule[], value: unknown, defaultDirection?: FaultDirection): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const rule = ruleFrom(candidate, defaultDirection);
    if (rule) target.push(rule);
  }
}

function parsePlan(raw: string | undefined): FaultRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rules: FaultRule[] = [];
  if (Array.isArray(parsed)) {
    appendRules(rules, parsed);
    return rules;
  }
  const plan = asRecord(parsed);
  if (!plan) return rules;
  // Accept directional rule arrays and flat `rules`/`faults` arrays. Rules
  // may use the current nested `match` selector or the legacy flat selector.
  appendRules(rules, plan.inbound, "inbound");
  appendRules(rules, plan.outbound, "outbound");
  appendRules(rules, plan.rules);
  appendRules(rules, plan.faults);
  return rules;
}

function messagePlane(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) return undefined;
  if (typeof record.plane === "string") return record.plane;
  const publication = asRecord(record.publication);
  if (typeof publication?.plane === "string") return publication.plane;
  const payload = asRecord(record.payload);
  return typeof payload?.plane === "string" ? payload.plane : undefined;
}

function messageType(message: unknown): string | undefined {
  const record = asRecord(message);
  return typeof record?.type === "string" ? record.type : undefined;
}

/**
 * Applies a deterministic, per-SessionHost test fault plan at one child IPC
 * boundary. Rules are evaluated in plan order. The binding form is
 * `{ match: { type, plane?, nth? }, action, delayMs? }`; the older flat form
 * remains accepted for existing plans. `nth` counts matching messages for that
 * rule; without it, every matching message is affected. Reorder holds a
 * selected message until the next message matching that rule's type/plane
 * selector, then delivers the successor before the held message. A held final
 * message is discarded on `dispose`: neither IPC seam can safely invoke a
 * delivery callback after its SessionHost is closing.
 */
export class TestFaultInjector {
  private readonly rules: FaultRule[];
  private readonly reordered: Partial<Record<FaultDirection, DeferredDelivery>> = {};
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(rules: FaultRule[]) {
    this.rules = rules;
  }

  static fromEnvironment(): TestFaultInjector {
    return new TestFaultInjector(parsePlan(process.env.PIVIS_TEST_FAULT_PLAN));
  }

  inbound(message: unknown, deliver: () => void): void {
    this.inject("inbound", message, deliver);
  }

  outbound(message: unknown, deliver: () => void): void {
    this.inject("outbound", message, deliver);
  }

  /** Cancel delayed traffic and discard an unmatched reorder on SessionHost close. */
  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    delete this.reordered.inbound;
    delete this.reordered.outbound;
  }

  private inject(direction: FaultDirection, message: unknown, deliver: () => void): void {
    const held = this.reordered[direction];
    const rule = this.match(direction, message);

    if (held) {
      this.apply(rule, deliver);
      if (this.matchesSelector(held.rule, message)) {
        delete this.reordered[direction];
        held.deliver();
      }
      return;
    }

    if (rule?.action === "reorder") {
      this.reordered[direction] = { rule, deliver };
      return;
    }

    this.apply(rule, deliver);
  }

  private match(direction: FaultDirection, message: unknown): FaultRule | undefined {
    const type = messageType(message);
    if (!type) return undefined;
    const plane = messagePlane(message);
    for (const rule of this.rules) {
      if (
        rule.direction !== direction ||
        rule.type !== type ||
        (rule.plane !== undefined && rule.plane !== plane)
      )
        continue;
      rule.seen++;
      if (rule.nth === undefined || rule.nth === rule.seen) return rule;
    }
    return undefined;
  }

  private matchesSelector(rule: FaultRule, message: unknown): boolean {
    return (
      rule.type === messageType(message) &&
      (rule.plane === undefined || rule.plane === messagePlane(message))
    );
  }

  private apply(rule: FaultRule | undefined, deliver: () => void): void {
    switch (rule?.action) {
      case "drop":
        return;
      case "duplicate":
        deliver();
        deliver();
        return;
      case "delay": {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          deliver();
        }, rule.delayMs);
        this.timers.add(timer);
        return;
      }
      default:
        deliver();
    }
  }
}
