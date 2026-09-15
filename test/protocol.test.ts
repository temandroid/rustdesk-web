import { describe, expect, it } from "vitest";
import { getVersionNumber, isSupportMultiUiSession } from "../src/version";
import { buildWsUrl, splitHostPort } from "../src/transport/ws";
import { buildMouseEvent } from "../src/input/mouse";
import { buildCtrlAltDel, buildLegacyKeyEvent } from "../src/input/keyboard";
import { ControlKey, KeyboardMode } from "../src/proto/message_pb";
import { checkIfRetry, imageQualityEnum } from "../src/session";
import { buildMapKeyEvent, peerCodeForUsbHid } from "../src/input/mapmode";

describe("getVersionNumber (hbb_common lib.rs)", () => {
  it("matches the documented examples", () => {
    expect(getVersionNumber("1.1.10")).toBe(1001100);
    expect(getVersionNumber("1.2.3")).toBe(1002030);
    expect(getVersionNumber("1.2.3-2")).toBe(1002032);
    expect(getVersionNumber("1.5.0")).toBe(1005000);
    expect(getVersionNumber("")).toBe(0);
  });
  it("gates multi-ui-session on > 1.2.4", () => {
    expect(isSupportMultiUiSession("1.2.4")).toBe(false);
    expect(isSupportMultiUiSession("1.2.5")).toBe(true);
    expect(isSupportMultiUiSession("1.5.0")).toBe(true);
  });
});

describe("buildWsUrl (hbb_common websocket.rs check_ws)", () => {
  it("maps domains to /ws/id and /ws/relay", () => {
    expect(buildWsUrl("rustdesk.example.com", "id")).toBe("ws://rustdesk.example.com/ws/id");
    expect(buildWsUrl("rustdesk.example.com:21116", "id", { secure: true })).toBe("wss://rustdesk.example.com/ws/id");
    expect(buildWsUrl("rustdesk.example.com:21117", "relay", { secure: true })).toBe("wss://rustdesk.example.com/ws/relay");
  });
  it("maps IP literals to port+2", () => {
    expect(buildWsUrl("127.0.0.1", "id")).toBe("ws://127.0.0.1:21118");
    expect(buildWsUrl("127.0.0.1:21116", "id")).toBe("ws://127.0.0.1:21118");
    expect(buildWsUrl("127.0.0.1:21117", "relay")).toBe("ws://127.0.0.1:21119");
    expect(buildWsUrl("127.0.0.1", "relay")).toBe("ws://127.0.0.1:21119");
    expect(buildWsUrl("127.0.0.1:34567", "relay")).toBe("ws://127.0.0.1:34569");
    expect(buildWsUrl("[::1]:21116", "id")).toBe("ws://[::1]:21118");
  });
  it("passes explicit ws(s) urls through and appends the kind path to bare origins", () => {
    expect(buildWsUrl("wss://x.example/ws/id", "id")).toBe("wss://x.example/ws/id");
    expect(buildWsUrl("ws://localhost:5179", "id")).toBe("ws://localhost:5179/ws/id");
    expect(buildWsUrl("ws://localhost:5179", "relay")).toBe("ws://localhost:5179/ws/relay");
    expect(buildWsUrl("ws://localhost:5179/", "relay")).toBe("ws://localhost:5179/ws/relay");
  });
  it("splits host:port", () => {
    expect(splitHostPort("a.b:1")).toEqual({ host: "a.b", port: 1 });
    expect(splitHostPort("a.b")).toEqual({ host: "a.b", port: null });
    expect(splitHostPort("[::1]:5")).toEqual({ host: "[::1]", port: 5 });
  });
});

describe("buildMouseEvent (flutter_ffi.rs session_send_mouse)", () => {
  it("packs type and button into the mask", () => {
    const e = buildMouseEvent({ type: "down", buttons: "left", x: "10", y: "20" })!;
    expect(e.mask).toBe(1 | (1 << 3));
    expect(e.x).toBe(10);
    expect(e.y).toBe(20);
    expect(buildMouseEvent({ type: "up", buttons: "right" })!.mask).toBe(2 | (2 << 3));
    expect(buildMouseEvent({ type: "wheel", buttons: "wheel" })!.mask).toBe(3 | (4 << 3));
    expect(buildMouseEvent({ type: "trackpad" })!.mask).toBe(4);
    expect(buildMouseEvent({ x: "1", y: "2" })!.mask).toBe(0);
    expect(buildMouseEvent({ type: "down", buttons: "back" })!.mask).toBe(1 | (8 << 3));
    expect(buildMouseEvent({ type: "down", buttons: "forward" })!.mask).toBe(1 | (16 << 3));
  });
  it("orders modifiers Alt, Shift, Control, Meta", () => {
    const e = buildMouseEvent({ x: "0", y: "0", ctrl: "true", alt: "true", command: "true", shift: "true" })!;
    expect(e.modifiers).toEqual([ControlKey.Alt, ControlKey.Shift, ControlKey.Control, ControlKey.Meta]);
  });
  it("filters relative-mode markers like Rust", () => {
    expect(buildMouseEvent({ relative_mouse_mode: "0" })).toBeNull();
    expect(buildMouseEvent({ relative_mouse_mode: "1", type: "move", x: "0", y: "0" })).toBeNull();
    expect(buildMouseEvent({ relative_mouse_mode: "1", type: "move_relative", x: "1", y: "0" })).toBeNull();
    expect(buildMouseEvent({ relative_mouse_mode: "1", type: "move_relative", x: "0", y: "0", alt: "true" })).toBeNull();
    expect(buildMouseEvent({ relative_mouse_mode: "1", type: "move_relative", x: "0", y: "0" })!.mask).toBe(5);
  });
  it("swaps left/right when requested", () => {
    expect(buildMouseEvent({ type: "down", buttons: "left" }, { swapLeftRight: true })!.mask).toBe(1 | (2 << 3));
  });
});

describe("legacy keyboard", () => {
  const f = { down: false, press: false, alt: false, ctrl: false, shift: false, command: false };
  it("maps VK names and single characters", () => {
    const a = buildLegacyKeyEvent("VK_A", { ...f, down: true })!;
    expect(a.union).toEqual({ case: "chr", value: "a".charCodeAt(0) });
    expect(a.down).toBe(true);
    expect(a.mode).toBe(KeyboardMode.Legacy);
    const ret = buildLegacyKeyEvent("VK_RETURN", { ...f, press: true })!;
    expect(ret.union).toEqual({ case: "controlKey", value: ControlKey.Return });
    expect(ret.press).toBe(true);
    expect(ret.down).toBe(false);
    expect(buildLegacyKeyEvent("é", f)!.union).toEqual({ case: "chr", value: "é".codePointAt(0) });
    expect(buildLegacyKeyEvent("VK_NOPE", f)).toBeNull();
  });
  it("does not add a modifier for the modifier key itself", () => {
    const ctrl = buildLegacyKeyEvent("VK_CONTROL", { ...f, down: true, ctrl: true })!;
    expect(ctrl.modifiers).toEqual([]);
    const c = buildLegacyKeyEvent("VK_C", { ...f, down: true, ctrl: true, shift: true })!;
    expect(c.modifiers).toEqual([ControlKey.Shift, ControlKey.Control]);
  });
  it("builds ctrl-alt-del per platform", () => {
    const w = buildCtrlAltDel("Windows");
    expect(w.union).toEqual({ case: "controlKey", value: ControlKey.CtrlAltDel });
    expect(w.down).toBe(true);
    const l = buildCtrlAltDel("Linux");
    expect(l.union).toEqual({ case: "controlKey", value: ControlKey.Delete });
    expect(l.press).toBe(true);
    expect(l.modifiers).toEqual([ControlKey.Alt, ControlKey.Control]);
  });
});

describe("misc ports", () => {
  it("checkIfRetry", () => {
    expect(checkIfRetry("error", "Connection Error", "Timeout")).toBe(true);
    expect(checkIfRetry("error", "Connection Error", "Remote desktop is offline")).toBe(false);
    expect(checkIfRetry("error", "Login Error", "x")).toBe(false);
  });
  it("imageQualityEnum honours ignore_default", () => {
    expect(imageQualityEnum("balanced", true)).toBeNull();
    expect(imageQualityEnum("balanced", false)).not.toBeNull();
    expect(imageQualityEnum("custom", false)).toBeNull();
  });
});

describe("map keyboard mode (rdev usb-hid tables)", () => {
  it("maps Enter and Backspace per peer platform", () => {
    expect(peerCodeForUsbHid(0x28, "Windows")).toBe(0x1c);
    expect(peerCodeForUsbHid(0x2a, "Windows")).toBe(0x0e);
    expect(peerCodeForUsbHid(0x28, "Linux")).toBe(36);
    expect(peerCodeForUsbHid(0x2a, "Linux")).toBe(22);
    expect(peerCodeForUsbHid(0x28, "Mac OS")).toBe(36);
    expect(peerCodeForUsbHid(0x2a, "Mac OS")).toBe(51);
    expect(peerCodeForUsbHid(0x04, "Android")).toBe(29);
  });
  it("keeps 0xE0-prefixed Windows extended scancodes", () => {
    expect(peerCodeForUsbHid(0x50, "Windows")).toBe(0xe04b);
    expect(peerCodeForUsbHid(0xe3, "Windows")).toBe(0xe05b);
  });
  it("builds Map-mode events with lock modifiers", () => {
    const a = buildMapKeyEvent(0x04, true, 1 << 1, "Windows")!;
    expect(a.union).toEqual({ case: "chr", value: 30 });
    expect(a.mode).toBe(KeyboardMode.Map);
    expect(a.down).toBe(true);
    expect(a.modifiers).toEqual([ControlKey.CapsLock]);
    const kp = buildMapKeyEvent(0x59, false, 1 << 2, "Windows")!;
    expect(kp.modifiers).toEqual([ControlKey.NumLock]);
    const enter = buildMapKeyEvent(0x28, true, 0, "Windows")!;
    expect(enter.union).toEqual({ case: "chr", value: 0x1c });
    expect(enter.modifiers).toEqual([]);
    expect(buildMapKeyEvent(0xffff, true, 0, "Windows")).toBeNull();
  });
  it("sends Pause to Windows peers as a legacy control key", () => {
    const p = buildMapKeyEvent(0x48, true, 0, "Windows")!;
    expect(p.mode).toBe(KeyboardMode.Legacy);
    expect(p.union).toEqual({ case: "controlKey", value: ControlKey.Pause });
  });
});

describe("clipboard", async () => {
  const { isSupportMultiClipboard, textFromClipboards, buildClipboardMessage } = await import("../src/clipboard");
  const { ClipboardFormat } = await import("../src/proto/message_pb");
  it("picks multi vs single form by peer version/platform", () => {
    expect(isSupportMultiClipboard("1.4.9", "Windows")).toBe(true);
    expect(isSupportMultiClipboard("1.2.7", "Windows")).toBe(false);
    expect(isSupportMultiClipboard("1.3.2", "Android")).toBe(false);
    expect(isSupportMultiClipboard("1.3.3", "Android")).toBe(true);
    expect(isSupportMultiClipboard("1.4.9", "iOS")).toBe(false);
    expect(buildClipboardMessage("x", "1.4.9", "Windows").union.case).toBe("multiClipboards");
    expect(buildClipboardMessage("x", "1.2.0", "Windows").union.case).toBe("clipboard");
  });
  it("decodes the first Text entry", () => {
    const enc = new TextEncoder();
    const cbs = [
      { format: ClipboardFormat.Html, compress: false, content: enc.encode("<b>x</b>") },
      { format: ClipboardFormat.Text, compress: false, content: enc.encode("hello") },
    ];
    expect(textFromClipboards(cbs as never)).toBe("hello");
    expect(textFromClipboards([cbs[0]] as never)).toBeNull();
  });
});

describe("webrtc transport helpers", async () => {
  const { encodeEndpoint, decodeEndpoint, endpointDeclaresAllIce, fingerprintFromSdp, parseIceServer, buildIceServers, DEFAULT_ICE_SERVERS } = await import("../src/transport/webrtc");
  it("round-trips the webrtc:// envelope", () => {
    const ep = encodeEndpoint("offer", "v=0\r\n", false);
    expect(ep.startsWith("webrtc://")).toBe(true);
    expect(decodeEndpoint(ep)).toEqual({ type: "offer", sdp: "v=0\r\n", ice_policy: "all" });
    expect(endpointDeclaresAllIce(ep)).toBe(true);
    expect(endpointDeclaresAllIce(encodeEndpoint("offer", "v=0\r\n", true))).toBe(false);
  });
  it("finds the fingerprint like get_key_for_sdp", () => {
    const session = "v=0\r\na=fingerprint:sha-256 AA:BB\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 CC:DD\r\n";
    expect(fingerprintFromSdp(session)).toBe("sha-256 AA:BB");
    const media = "v=0\r\nm=audio 9 RTP/AVP 0\r\na=fingerprint:sha-256 11:22\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 CC:DD\r\n";
    expect(fingerprintFromSdp(media)).toBe("sha-256 CC:DD");
    expect(fingerprintFromSdp("v=0\r\n")).toBeNull();
  });
  it("parses ICE server urls and always keeps a STUN entry", () => {
    expect(parseIceServer("stun:stun.example.com:3478")).toEqual({ urls: "stun:stun.example.com:3478" });
    expect(parseIceServer("turn://u:p@turn.example.com:3478")).toEqual({ urls: "turn:turn.example.com:3478", username: "u", credential: "p" });
    expect(parseIceServer("turn:turn.example.com:3478")).toBeNull();
    expect(buildIceServers(["turn://u:p@t:1"]).length).toBe(1 + DEFAULT_ICE_SERVERS.length);
    expect(buildIceServers(["stun:s:1"]).length).toBe(1);
  });
});
