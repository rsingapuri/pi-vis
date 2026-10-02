import type { EventEmitter } from "node:events";

export interface HostWireMessage {
  type: string;
  [key: string]: unknown;
}

export class FakeHostProcess extends EventEmitter {
  sent: HostWireMessage[];
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killSignal?: NodeJS.Signals;
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter;
  connected: boolean;
  disconnectCalls: number;
  initialized: boolean;
  hostInstanceId: string;
  transportSequence: number;
  sessionEpoch: number;
  snapshotSequence: number;
  beforeEditorPatch:
    | ((patch: {
        baseRevision: number;
        revision: number;
        text: string;
        attachments: unknown[];
        alternateConflictText?: string;
        alternateConflictAttachments?: unknown[];
        additionalConflictCandidates?: Array<{ text: string; attachments: unknown[] }>;
      }) => void)
    | undefined;
  autoRespondToStateRequests: boolean;
  editor: {
    revision: number;
    text: string;
    attachments: unknown[];
    conflictText?: string;
    conflictAttachments?: unknown[];
    alternateConflictText?: string;
    alternateConflictAttachments?: unknown[];
    additionalConflictCandidates?: Array<{ text: string; attachments: unknown[] }>;
  };
  runtime: {
    isStreaming: boolean;
    isIdle: boolean;
    isCompacting: boolean;
    isRetrying: boolean;
    retryAttempt: number;
    isBashRunning: boolean;
  };
  snapshot(): Record<string, unknown>;
  emitWire(msg: HostWireMessage): void;
  emitControl(payload: HostWireMessage): void;
  send(msg: HostWireMessage, _cb?: (err: Error | null) => void): boolean;
  emitMessage(msg: HostWireMessage): void;
  emitStderr(text: string): void;
  emitSpawned(): void;
  emitReady(piVersion?: string): void;
  emitError(message: string, opts?: { versionTooLow?: boolean }): void;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  disconnect(): void;
  kill(signal?: NodeJS.Signals): boolean;
}
