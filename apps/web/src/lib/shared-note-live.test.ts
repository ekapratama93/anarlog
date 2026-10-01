import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import assert from "node:assert/strict";
import test from "node:test";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import {
  buildSharedNoteLiveSocketUrl,
  type LiveSocket,
  NOTE_FRAGMENT_NAME,
  parseSharedNoteLiveControlMessage,
  parseSharedNoteLiveTicket,
  SharedNoteLiveClient,
  titleFromDocument,
} from "./shared-note-live.ts";

/** In-memory socket paired with a yjs doc standing in for the relay. */
class FakeRelay {
  readonly doc = new Y.Doc();
  readonly sockets: FakeSocket[] = [];
  seedRequired: boolean;

  constructor(seedRequired: boolean) {
    this.seedRequired = seedRequired;
  }

  open(capability: "editor" | "viewer" = "editor"): FakeSocket {
    const socket = new FakeSocket(this, capability);
    this.sockets.push(socket);
    setTimeout(() => {
      socket.onopen?.(new Event("open"));
      socket.onmessage?.(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "ready",
            capability,
            contentRevision: 7,
            seedRequired: this.seedRequired,
          }),
        }),
      );
      this.seedRequired = false;
    }, 0);
    return socket;
  }
}

class FakeSocket implements LiveSocket {
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  private readonly relay: FakeRelay;
  private readonly capability: "editor" | "viewer";

  constructor(relay: FakeRelay, capability: "editor" | "viewer") {
    this.relay = relay;
    this.capability = capability;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    assert.ok(data instanceof Uint8Array);
    const decoder = decoding.createDecoder(data);
    assert.equal(decoding.readVarUint(decoder), 0);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    const messageType = decoding.peekVarUint(decoder);
    if (messageType === syncProtocol.messageYjsUpdate) {
      decoding.readVarUint(decoder);
      if (this.capability !== "editor") return;
      const update = decoding.readVarUint8Array(decoder);
      Y.applyUpdate(this.relay.doc, update, this);
      for (const other of this.relay.sockets) {
        if (other === this || other.closed) continue;
        const relayed = encoding.createEncoder();
        encoding.writeVarUint(relayed, 0);
        syncProtocol.writeUpdate(relayed, update);
        other.onmessage?.(
          new MessageEvent("message", {
            data: encoding.toUint8Array(relayed).buffer,
          }),
        );
      }
      return;
    }
    syncProtocol.readSyncMessage(decoder, encoder, this.relay.doc, this);
    if (encoding.length(encoder) > 1) {
      this.onmessage?.(
        new MessageEvent("message", {
          data: encoding.toUint8Array(encoder).buffer,
        }),
      );
    }
  }

  close(): void {
    this.closed = true;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("builds ws/wss urls from the API base", () => {
  assert.equal(
    buildSharedNoteLiveSocketUrl("http://localhost:3001", "abc", "t k"),
    "ws://localhost:3001/sync/shares/abc/live?ticket=t+k",
  );
  assert.equal(
    buildSharedNoteLiveSocketUrl("https://api.anarlog.so/", "abc", "x"),
    "wss://api.anarlog.so/sync/shares/abc/live?ticket=x",
  );
});

test("parses control and ticket payloads strictly", () => {
  assert.deepEqual(
    parseSharedNoteLiveControlMessage(
      '{"type":"ready","capability":"viewer","contentRevision":3,"seedRequired":false}',
    ),
    {
      type: "ready",
      capability: "viewer",
      contentRevision: 3,
      seedRequired: false,
    },
  );
  assert.deepEqual(parseSharedNoteLiveControlMessage('{"type":"reset"}'), {
    type: "reset",
  });
  assert.equal(parseSharedNoteLiveControlMessage("not json"), null);
  assert.equal(parseSharedNoteLiveControlMessage('{"type":"nope"}'), null);
  assert.throws(() => parseSharedNoteLiveTicket({ ticket: "" }));
  assert.equal(
    parseSharedNoteLiveTicket({
      ticket: "abc",
      capability: "editor",
      contentRevision: 0,
      expiresInSeconds: 60,
    }).capability,
    "editor",
  );
});

test("titleFromDocument reads the leading heading", () => {
  assert.equal(
    titleFromDocument(
      {
        type: "doc",
        content: [
          { type: "heading", content: [{ type: "text", text: " Hi " }] },
        ],
      },
      "fallback",
    ),
    "Hi",
  );
  assert.equal(
    titleFromDocument({ type: "doc", content: [{ type: "paragraph" }] }, "fb"),
    "fb",
  );
});

test("seeds an empty relay document once and syncs two editors", async () => {
  const relay = new FakeRelay(true);
  const statuses: string[] = [];
  let seeds = 0;
  const a = new SharedNoteLiveClient({
    connect: async () => ({ status: "ready", socket: relay.open() }),
    seed: (fragment) => {
      seeds += 1;
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText("seeded")]);
      fragment.insert(0, [paragraph]);
    },
    onStatus: (status) => statuses.push(status.kind),
    onRemoteRevision: (revision) => assert.equal(revision, 7),
  });
  await flush();
  assert.deepEqual(statuses, ["live"]);
  assert.equal(seeds, 1);
  assert.ok(a.isSynced());
  assert.equal(relay.doc.getXmlFragment(NOTE_FRAGMENT_NAME).length, 1);

  const b = new SharedNoteLiveClient({
    connect: async () => ({ status: "ready", socket: relay.open() }),
    seed: () => assert.fail("second peer must not seed"),
  });
  await flush();
  assert.equal(b.fragment.length, 1);
  assert.equal(b.fragment.toString(), a.fragment.toString());

  b.doc.transact(() => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("from b")]);
    b.fragment.insert(1, [paragraph]);
  });
  assert.equal(a.fragment.length, 2);
  assert.equal(a.fragment.toString(), b.fragment.toString());

  a.destroy();
  b.destroy();
  assert.equal(a.getStatus().kind, "closed");
});

test("viewer edits are dropped by the relay and forbidden stops retrying", async () => {
  const relay = new FakeRelay(false);
  const viewer = new SharedNoteLiveClient({
    connect: async () => ({ status: "ready", socket: relay.open("viewer") }),
    seed: () => assert.fail("viewers never seed"),
  });
  await flush();
  assert.deepEqual(viewer.getStatus(), { kind: "live", capability: "viewer" });
  viewer.fragment.insert(0, [new Y.XmlElement("paragraph")]);
  assert.equal(relay.doc.getXmlFragment(NOTE_FRAGMENT_NAME).length, 0);
  viewer.destroy();

  let attempts = 0;
  const denied = new SharedNoteLiveClient({
    connect: async () => {
      attempts += 1;
      return { status: "forbidden" };
    },
    seed: () => {},
    setTimeoutFn: ((fn: () => void) => {
      fn();
      return 0;
    }) as unknown as typeof setTimeout,
  });
  await flush();
  assert.equal(denied.getStatus().kind, "forbidden");
  assert.equal(attempts, 1);
  denied.destroy();
});

test("reset swaps in a fresh doc and reports it", async () => {
  const relay = new FakeRelay(false);
  let resets = 0;
  const client = new SharedNoteLiveClient({
    connect: async () => ({ status: "ready", socket: relay.open() }),
    seed: () => {},
    onReset: () => (resets += 1),
  });
  await flush();
  const before = client.doc;
  client.fragment.insert(0, [new Y.XmlElement("paragraph")]);
  relay.sockets[0]?.onmessage?.(
    new MessageEvent("message", { data: JSON.stringify({ type: "reset" }) }),
  );
  assert.equal(resets, 1);
  assert.notEqual(client.doc, before);
  assert.equal(client.fragment.length, 0);
  assert.equal(client.isSynced(), false);
  client.destroy();
});
