import { beforeAll, describe, expect, it } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  FeaturesSchema,
  HashSchema,
  LoginResponseSchema,
  MessageSchema,
  OptionMessage_BoolOption,
  PeerInfoSchema,
  TerminalClosedSchema,
  TerminalDataSchema,
  TerminalErrorSchema,
  TerminalOpenedSchema,
  TerminalResponseSchema,
  type Message,
  type TerminalResponse,
} from "../src/proto/message_pb";
import { ConnType } from "../src/proto/rendezvous_pb";
import {
  buildCloseTerminal,
  buildOpenTerminal,
  buildResizeTerminal,
  buildTerminalInput,
  encode64,
  terminalResponseEvent,
  terminalServiceIdKey,
  terminalSupportError,
} from "../src/terminal";
import { Session, type Fields } from "../src/session";
import { initCrypto } from "../src/crypto";

beforeAll(async () => {
  await initCrypto();
  // PeerStore persists to localStorage; give the node test env an in-memory one.
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
    },
  });
});

// Round-trip through the wire format so field numbers are exercised too.
function wire(m: Message): Message {
  return fromBinary(MessageSchema, toBinary(MessageSchema, m));
}

function action(m: Message) {
  const w = wire(m);
  expect(w.union.case).toBe("terminalAction");
  return w.union.case === "terminalAction" ? w.union.value.union : null;
}

function resp(u: TerminalResponse["union"]): TerminalResponse {
  const r = create(TerminalResponseSchema, {});
  r.union = u;
  return fromBinary(TerminalResponseSchema, toBinary(TerminalResponseSchema, r));
}

// Reference base64 (byte by byte) and its inverse.
function refB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function unB64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Minimal zstd frame (RFC 8878): single segment, 1-byte content size, one raw
// last block. Enough to exercise the `compressed` path without an encoder.
function zstdRawFrame(content: Uint8Array): Uint8Array {
  expect(content.length).toBeLessThan(256);
  const n = content.length;
  const bh = 1 | (0 << 1) | (n << 3);
  return new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, n, bh & 0xff, (bh >> 8) & 0xff, (bh >> 16) & 0xff, ...content]);
}

describe("TerminalAction builders (ui_session_interface.rs)", () => {
  it("open", () => {
    const a = action(buildOpenTerminal(2, 30, 120));
    expect(a?.case).toBe("open");
    expect(a?.value).toMatchObject({ terminalId: 2, rows: 30, cols: 120 });
  });
  it("data is the UTF-8 bytes of the input, uncompressed", () => {
    const a = action(buildTerminalInput(0, "ls -l é中\r"));
    expect(a?.case).toBe("data");
    if (a?.case !== "data") return;
    expect(a.value.terminalId).toBe(0);
    expect(a.value.compressed).toBe(false);
    expect(new TextDecoder().decode(a.value.data)).toBe("ls -l é中\r");
    expect(a.value.data.length).toBe(12);
  });
  it("resize", () => {
    const a = action(buildResizeTerminal(1, 40, 100));
    expect(a?.case).toBe("resize");
    expect(a?.value).toMatchObject({ terminalId: 1, rows: 40, cols: 100 });
  });
  it("close", () => {
    const a = action(buildCloseTerminal(3));
    expect(a?.case).toBe("close");
    expect(a?.value).toMatchObject({ terminalId: 3 });
  });
  it("clamps bad sizes to 0 instead of throwing", () => {
    const a = action(buildOpenTerminal(0, NaN, -5));
    expect(a?.value).toMatchObject({ terminalId: 0, rows: 0, cols: 0 });
  });
});

describe("terminal_response events (flutter.rs handle_terminal_response)", () => {
  it("opened carries native ints/bools and persistent_sessions only when present", () => {
    const ev = terminalResponseEvent(
      resp({
        case: "opened",
        value: create(TerminalOpenedSchema, {
          terminalId: 1,
          success: true,
          message: "Terminal opened",
          pid: 4242,
          serviceId: "svc-1",
          replayTerminalOutput: true,
          persistentSessions: [1, 2],
        }),
      })
    );
    expect(ev).toEqual({
      type: "opened",
      terminal_id: 1,
      success: true,
      message: "Terminal opened",
      pid: 4242,
      service_id: "svc-1",
      replay_terminal_output: true,
      persistent_sessions: [1, 2],
    });
    const ev2 = terminalResponseEvent(resp({ case: "opened", value: create(TerminalOpenedSchema, { terminalId: 0 }) }));
    expect(ev2).not.toHaveProperty("persistent_sessions");
    expect(ev2?.["success"]).toBe(false);
  });
  it("data is base64 of the raw bytes", () => {
    const bytes = new TextEncoder().encode("hello é中\x1b[0m\r\n");
    const ev = terminalResponseEvent(resp({ case: "data", value: create(TerminalDataSchema, { terminalId: 0, data: bytes }) }));
    expect(ev).toEqual({ type: "data", terminal_id: 0, data: refB64(bytes) });
    expect(new TextDecoder().decode(unB64(String(ev?.["data"])))).toBe("hello \u00e9\u4e2d\x1b[0m\r\n");
  });
  it("data with `compressed` is zstd-decoded first", () => {
    const plain = new TextEncoder().encode("compressed output ✓");
    const ev = terminalResponseEvent(
      resp({ case: "data", value: create(TerminalDataSchema, { terminalId: 5, data: zstdRawFrame(plain), compressed: true }) })
    );
    expect(ev?.["terminal_id"]).toBe(5);
    expect(new TextDecoder().decode(unB64(String(ev?.["data"])))).toBe("compressed output ✓");
  });
  it("closed and error", () => {
    expect(terminalResponseEvent(resp({ case: "closed", value: create(TerminalClosedSchema, { terminalId: 2, exitCode: -1 }) }))).toEqual({
      type: "closed",
      terminal_id: 2,
      exit_code: -1,
    });
    expect(terminalResponseEvent(resp({ case: "error", value: create(TerminalErrorSchema, { terminalId: 2, message: "boom" }) }))).toEqual({
      type: "error",
      terminal_id: 2,
      message: "boom",
    });
    expect(terminalResponseEvent(create(TerminalResponseSchema, {}))).toBeNull();
  });
  it("encode64 handles large buffers", () => {
    const big = new Uint8Array(200_000).map((_, i) => i & 0xff);
    expect(encode64(big)).toBe(refB64(big));
  });
});

describe("terminal support check (io_loop.rs check_terminal_support)", () => {
  it("feature flag wins, otherwise version decides the message", () => {
    expect(terminalSupportError(true, "1.3.0")).toBeNull();
    expect(terminalSupportError(false, "1.4.0")?.title).toBe("Remote terminal not supported");
    expect(terminalSupportError(false, "1.4.1")).toEqual({
      type: "error",
      title: "Error",
      text: "Remote terminal is not supported by the remote side",
    });
  });
  it("service id key", () => {
    expect(terminalServiceIdKey(false)).toBe("terminal-service-id");
    expect(terminalServiceIdKey(true)).toBe("terminal-admin-service-id");
  });
});

// Drives the Session state machine with a fake transport.
function terminalSession(isTerminalAdmin = false) {
  const sent: Message[] = [];
  const events: { name: string; fields: Fields }[] = [];
  let closed = false;
  const s = new Session(
    { id: "123456789", password: "pw", isSharedPassword: false, connType: ConnType.TERMINAL, isTerminalAdmin },
    {
      emit: (name, fields) => void events.push({ name, fields }),
      onVideoFrame: () => false,
      onRgba: () => false,
      onClosed: () => {
        closed = true;
      },
    }
  );
  const priv = s as unknown as Record<string, unknown>;
  priv["ws"] = {
    send: (b: Uint8Array) => void sent.push(fromBinary(MessageSchema, b)),
    close: () => {},
    bufferedAmount: 0,
  };
  priv["state"] = "wait-hash";
  const feed = (m: Message) => (priv["handlePeerMessage"] as (m: Message) => Promise<boolean>).call(s, m);
  return { s, sent, events, feed, isClosed: () => closed };
}

function hashMsg(): Message {
  const m = create(MessageSchema, {});
  m.union = { case: "hash", value: create(HashSchema, { salt: "salt", challenge: "chal" }) };
  return m;
}

function peerInfoMsg(version: string, terminal: boolean): Message {
  const lr = create(LoginResponseSchema, {});
  lr.union = {
    case: "peerInfo",
    value: create(PeerInfoSchema, {
      username: "u",
      hostname: "h",
      platform: "Linux",
      version,
      features: create(FeaturesSchema, { terminal }),
    }),
  };
  const m = create(MessageSchema, {});
  m.union = { case: "loginResponse", value: lr };
  return m;
}

describe("Session in TERMINAL mode", () => {
  it("logs in with LoginRequest.terminal + os_login and no OptionMessage", async () => {
    const { sent, feed } = terminalSession();
    await feed(hashMsg());
    expect(sent).toHaveLength(1);
    const m = wire(sent[0]!);
    expect(m.union.case).toBe("loginRequest");
    if (m.union.case !== "loginRequest") return;
    const lr = m.union.value;
    expect(lr.union.case).toBe("terminal");
    expect(lr.union.case === "terminal" && lr.union.value.serviceId).toBe("");
    expect(lr.osLogin).toBeDefined();
    expect(lr.osLogin?.username).toBe("");
    expect(lr.option).toBeUndefined();
    expect(lr.password.length).toBe(32);
  });

  it("admin terminal asks for OS credentials before logging in", async () => {
    const { s, sent, events, feed } = terminalSession(true);
    await feed(hashMsg());
    expect(sent).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ name: "msgbox", fields: { type: "terminal-admin-login" } });
    s.login("", false, "Administrator", "secret");
    expect(sent).toHaveLength(1);
    const m = wire(sent[0]!);
    if (m.union.case !== "loginRequest") throw new Error("expected login");
    expect(m.union.value.osLogin).toMatchObject({ username: "Administrator", password: "secret" });
    expect(m.union.value.password.length).toBe(32);
  });

  it("peer_info without a success box, then terminal_response events and service id", async () => {
    const { s, sent, events, feed } = terminalSession();
    await feed(hashMsg());
    expect(await feed(peerInfoMsg("1.4.6", true))).toBe(true);
    expect(events.find((e) => e.name === "msgbox" && e.fields["type"] === "success")).toBeUndefined();
    const pi = events.find((e) => e.name === "peer_info");
    expect(pi?.fields["current_display"]).toBe("0");
    expect(s.isConnected).toBe(true);

    s.openTerminal(0, 24, 80);
    expect(action(sent.at(-1)!)?.case).toBe("open");

    const m = create(MessageSchema, {});
    m.union = {
      case: "terminalResponse",
      value: resp({ case: "opened", value: create(TerminalOpenedSchema, { terminalId: 0, success: true, serviceId: "svc-9" }) }),
    };
    await feed(m);
    const ev = events.at(-1)!;
    expect(ev.name).toBe("terminal_response");
    expect(ev.fields).toMatchObject({ type: "opened", terminal_id: 0, success: true, service_id: "svc-9" });
    // the service id is sent back on the next login (persistent sessions)
    expect((s as unknown as { peer: { getOption(k: string): string } }).peer.getOption("terminal-service-id")).toBe("svc-9");
  });

  it("persistent option rides in the login when toggled on", async () => {
    const { s, sent, feed } = terminalSession();
    (s as unknown as { peer: { getToggle(k: string): boolean } }).peer.getToggle = (k: string) => k === "terminal-persistent";
    await feed(hashMsg());
    const m = wire(sent[0]!);
    if (m.union.case !== "loginRequest") throw new Error("expected login");
    expect(m.union.value.option?.terminalPersistent).toBe(OptionMessage_BoolOption.Yes);
  });

  it("ends the session when the peer lacks the terminal feature", async () => {
    const { events, feed, isClosed } = terminalSession();
    await feed(hashMsg());
    expect(await feed(peerInfoMsg("1.3.9", false))).toBe(false);
    expect(events.at(-1)).toMatchObject({ name: "msgbox", fields: { title: "Remote terminal not supported" } });
    expect(isClosed()).toBe(true);
  });
});
