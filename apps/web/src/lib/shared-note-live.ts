import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { z } from "zod";

import {
  parseGatewaySharedNote,
  type SharedNoteSnapshot,
} from "./shared-notes.ts";

export const MAX_SHARED_NOTE_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const NOTE_FRAGMENT_NAME = "prosemirror";

const MESSAGE_SYNC = 0;
/** Transaction origin used when this client seeds an empty relay document. */
export const LIVE_SEED_ORIGIN = Symbol("shared-note-live-seed");
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const liveCapabilitySchema = z.enum(["editor", "viewer"]);
export type SharedNoteLiveCapability = z.infer<typeof liveCapabilitySchema>;

const liveTicketSchema = z
  .object({
    ticket: z.string().min(1).max(4096),
    capability: liveCapabilitySchema,
    contentRevision: z.number().int().nonnegative().safe(),
    expiresInSeconds: z.number().int().positive().safe(),
  })
  .strict();
export type SharedNoteLiveTicket = z.infer<typeof liveTicketSchema>;

export function parseSharedNoteLiveTicket(
  value: unknown,
): SharedNoteLiveTicket {
  return liveTicketSchema.parse(value);
}

const controlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      capability: liveCapabilitySchema,
      contentRevision: z.number().int().nonnegative().safe(),
      seedRequired: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("reset") }).strict(),
]);
export type SharedNoteLiveControlMessage = z.infer<typeof controlMessageSchema>;

export function parseSharedNoteLiveControlMessage(
  text: string,
): SharedNoteLiveControlMessage | null {
  try {
    return controlMessageSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

export type SharedNoteWebEditResult =
  | { status: "ready"; snapshot: SharedNoteSnapshot }
  | { status: "conflict" }
  | { status: "forbidden" }
  | { status: "error" };

const publishedSnapshotSchema = z
  .object({
    shareId: z.string(),
    schemaVersion: z.number(),
    contentRevision: z.number(),
    title: z.string(),
    body: z.unknown(),
    attachments: z.array(z.unknown()).max(64),
    webEditable: z.boolean(),
    accessVersion: z.number(),
    publishedAt: z.string(),
  })
  .strict();

export function parseSharedNoteWebEditResult(
  value: unknown,
): SharedNoteWebEditResult {
  try {
    const parsed = publishedSnapshotSchema.parse(value);
    const {
      webEditable: _webEditable,
      accessVersion: _accessVersion,
      ...rest
    } = parsed;
    return {
      status: "ready",
      snapshot: parseGatewaySharedNote({ ...rest, schemaVersion: 1 }),
    };
  } catch {
    return { status: "error" };
  }
}

export function buildSharedNoteLiveSocketUrl(
  apiUrl: string,
  shareId: string,
  ticket: string,
): string {
  const url = new URL(
    `/sync/shares/${encodeURIComponent(shareId)}/live`,
    apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`,
  );
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/** The subset of `WebSocket` the live client drives; injectable for tests. */
export interface LiveSocket {
  binaryType: BinaryType;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type SharedNoteLiveStatus =
  | { kind: "connecting" }
  | { kind: "live"; capability: SharedNoteLiveCapability }
  | { kind: "offline" }
  | { kind: "forbidden" }
  | { kind: "closed" };

export type SharedNoteLiveConnection =
  | { status: "ready"; socket: LiveSocket }
  | { status: "forbidden" }
  | { status: "error" };

export interface SharedNoteLiveClientOptions {
  /** Mints a ticket and opens a socket; returns `forbidden` to stop retrying. */
  connect: () => Promise<SharedNoteLiveConnection>;
  /** Called once per connection when the relay reports an empty document. */
  seed: (fragment: Y.XmlFragment) => void;
  /**
   * Called when the relay rejected this peer's seed because another peer
   * seeded first. The client has already replaced its `doc`; the editor must
   * rebind to the new one.
   */
  onReset?: () => void;
  onStatus?: (status: SharedNoteLiveStatus) => void;
  onRemoteRevision?: (contentRevision: number) => void;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Relays Yjs sync messages between a `Y.Doc` and the api-sync live route.
 * Frames follow y-protocols/sync (message type 0); JSON text frames carry
 * control messages. Awareness is not sent in this phase.
 */
export class SharedNoteLiveClient {
  doc: Y.Doc;
  private socket: LiveSocket | null = null;
  private status: SharedNoteLiveStatus = { kind: "connecting" };
  private destroyed = false;
  private attempts = 0;
  private synced = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly options: SharedNoteLiveClientOptions;

  constructor(options: SharedNoteLiveClientOptions) {
    this.options = options;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.doc = this.createDoc();
    void this.open();
  }

  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment(NOTE_FRAGMENT_NAME);
  }

  getStatus(): SharedNoteLiveStatus {
    return this.status;
  }

  isSynced(): boolean {
    return this.synced;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.doc.destroy();
    this.setStatus({ kind: "closed" });
  }

  private createDoc(): Y.Doc {
    const doc = new Y.Doc();
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this || !this.socket) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.socket.send(encoding.toUint8Array(encoder));
    });
    return doc;
  }

  private setStatus(status: SharedNoteLiveStatus) {
    this.status = status;
    this.options.onStatus?.(status);
    for (const listener of this.listeners) listener();
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
  }

  private async open(): Promise<void> {
    if (this.destroyed) return;
    this.synced = false;
    if (this.status.kind !== "connecting") {
      this.setStatus({ kind: "connecting" });
    }
    let connection: SharedNoteLiveConnection;
    try {
      connection = await this.options.connect();
    } catch {
      connection = { status: "error" };
    }
    if (this.destroyed) {
      if (connection.status === "ready") connection.socket.close();
      return;
    }
    if (connection.status === "forbidden") {
      this.setStatus({ kind: "forbidden" });
      return;
    }
    if (connection.status === "error") {
      this.scheduleReconnect();
      return;
    }

    const socket = connection.socket;
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.send(encoding.toUint8Array(encoder));
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      /* onclose follows */
    };
    socket.onclose = () => {
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer !== null) return;
    this.setStatus({ kind: "offline" });
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(this.attempts, 5),
    );
    this.attempts += 1;
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      void this.open();
    }, delay);
  }

  private handleMessage(data: unknown) {
    if (typeof data === "string") {
      const control = parseSharedNoteLiveControlMessage(data);
      if (!control) return;
      this.handleControl(control);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const decoder = decoding.createDecoder(new Uint8Array(data));
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    const messageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      this,
    );
    if (encoding.length(encoder) > 1 && this.socket) {
      this.socket.send(encoding.toUint8Array(encoder));
    }
    if (messageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
      this.synced = true;
      this.attempts = 0;
      if (this.status.kind === "live") {
        for (const listener of this.listeners) listener();
      }
    }
  }

  private handleControl(control: SharedNoteLiveControlMessage) {
    if (control.type === "reset") {
      const previous = this.doc;
      this.doc = this.createDoc();
      previous.destroy();
      this.synced = false;
      this.options.onReset?.();
      for (const listener of this.listeners) listener();
      return;
    }
    this.options.onRemoteRevision?.(control.contentRevision);
    if (control.seedRequired && this.fragment.length === 0) {
      this.doc.transact(
        () => this.options.seed(this.fragment),
        LIVE_SEED_ORIGIN,
      );
    }
    this.setStatus({ kind: "live", capability: control.capability });
  }
}

/** Extracts the note title from the leading heading, if present. */
export function titleFromDocument(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return fallback;
  const first = content[0] as { type?: unknown; content?: unknown };
  if (first.type !== "heading" || !Array.isArray(first.content)) {
    return fallback;
  }
  const text = first.content
    .map((node: { text?: unknown }) =>
      typeof node.text === "string" ? node.text : "",
    )
    .join("")
    .trim();
  return text.length > 0 ? text : fallback;
}
