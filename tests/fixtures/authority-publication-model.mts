export interface Owner {
  hostInstanceId: string;
  sessionEpoch: number;
}

export interface Publication<T = string> {
  owner: Owner;
  sequence: number;
  value: T;
}

export type PublicationState = "detached" | "following" | "synchronizing";

const ownerKey = (owner: Owner): string => `${owner.hostInstanceId}\0${owner.sessionEpoch}`;
const sameOwner = (left: Owner, right: Owner): boolean => ownerKey(left) === ownerKey(right);

/**
 * Small reference reducer for semantic publication. It deliberately models
 * only protocol invariants: owner fencing, contiguous publication sequences,
 * and an attach baseline followed by replay.
 */
export class PublicationModel<T = string> {
  state: PublicationState = "detached";
  owner: Owner | undefined;
  nextSequence: number | undefined;
  applied: Publication<T>[] = [];
  private attaching: Owner | undefined;
  private buffered: Publication<T>[] = [];

  installBaseline(owner: Owner, highWater: number): void {
    this.owner = owner;
    this.nextSequence = highWater + 1;
    this.state = "following";
    this.applied = [];
  }

  receive(publication: Publication<T>): "applied" | "ignored" | "gap" {
    if (!this.owner || !sameOwner(this.owner, publication.owner)) return "ignored";
    if (publication.sequence < this.nextSequence!) return "ignored";
    if (publication.sequence > this.nextSequence!) {
      this.state = "synchronizing";
      return "gap";
    }
    if (this.state !== "following") return "ignored";
    this.applied.push(publication);
    this.nextSequence!++;
    return "applied";
  }

  beginAttach(owner: Owner): void {
    this.attaching = owner;
    this.buffered = [];
    this.state = "detached";
  }

  buffer(publication: Publication<T>): void {
    if (this.attaching && sameOwner(this.attaching, publication.owner)) {
      this.buffered.push(publication);
    }
  }

  installAttachBaseline(owner: Owner, highWater: number): void {
    if (!this.attaching || !sameOwner(this.attaching, owner)) {
      throw new Error("attach baseline must belong to the owner being attached");
    }
    this.installBaseline(owner, highWater);
    const replay = this.buffered
      .filter((publication) => publication.sequence > highWater)
      .sort((left, right) => left.sequence - right.sequence);
    this.buffered = [];
    this.attaching = undefined;
    for (const publication of replay) this.receive(publication);
  }
}

export type IntentAdmission = "admitted" | "duplicate" | "payload_conflict" | "cross_owner";

interface IntentRecord {
  owner: Owner;
  payload: string;
  invocationCount: number;
}

/** Reference intent ledger: identity is stable within its owning runtime only. */
export class IntentLedgerModel {
  private readonly intents = new Map<string, IntentRecord>();

  admit(owner: Owner, intentId: string, payload: string): IntentAdmission {
    const existing = this.intents.get(intentId);
    if (!existing) {
      this.intents.set(intentId, { owner, payload, invocationCount: 1 });
      return "admitted";
    }
    if (!sameOwner(existing.owner, owner)) return "cross_owner";
    if (existing.payload !== payload) return "payload_conflict";
    return "duplicate";
  }

  invocationCount(intentId: string): number {
    return this.intents.get(intentId)?.invocationCount ?? 0;
  }
}
