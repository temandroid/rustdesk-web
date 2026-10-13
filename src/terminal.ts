// Remote terminal (ConnType.TERMINAL). Ports of
//  - src/ui_session_interface.rs open_terminal / send_terminal_input /
//    resize_terminal / close_terminal (outgoing TerminalAction), and
//  - src/flutter.rs handle_terminal_response (incoming TerminalResponse ->
//    "terminal_response" event for flutter/lib/models/terminal_model.dart).
import { create } from "@bufbuild/protobuf";
import { Decompress } from "fzstd";
import {
  CloseTerminalSchema,
  MessageSchema,
  OpenTerminalSchema,
  ResizeTerminalSchema,
  TerminalActionSchema,
  TerminalDataSchema,
  type Message,
  type TerminalAction,
  type TerminalResponse,
} from "./proto/message_pb";
import { getVersionNumber } from "./version";

export type TerminalEvent = Record<string, string | number | boolean | number[]>;

// client.rs get_key_terminal_service_id: the peer option that remembers the
// persistent service of the last terminal, sent back in LoginRequest.terminal.
export function terminalServiceIdKey(isAdmin: boolean): string {
  return isAdmin ? "terminal-admin-service-id" : "terminal-service-id";
}

function wrap(action: TerminalAction): Message {
  const m = create(MessageSchema, {});
  m.union = { case: "terminalAction", value: action };
  return m;
}

function u32(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) >>> 0 : 0;
}

function i32(v: number): number {
  return Number.isFinite(v) ? Math.trunc(v) | 0 : 0;
}

export function buildOpenTerminal(terminalId: number, rows: number, cols: number): Message {
  const a = create(TerminalActionSchema, {});
  a.union = { case: "open", value: create(OpenTerminalSchema, { terminalId: i32(terminalId), rows: u32(rows), cols: u32(cols) }) };
  return wrap(a);
}

// Input goes out as the UTF-8 bytes of the string, uncompressed.
export function buildTerminalInput(terminalId: number, data: string): Message {
  const a = create(TerminalActionSchema, {});
  a.union = {
    case: "data",
    value: create(TerminalDataSchema, { terminalId: i32(terminalId), data: new TextEncoder().encode(data), compressed: false }),
  };
  return wrap(a);
}

export function buildResizeTerminal(terminalId: number, rows: number, cols: number): Message {
  const a = create(TerminalActionSchema, {});
  a.union = { case: "resize", value: create(ResizeTerminalSchema, { terminalId: i32(terminalId), rows: u32(rows), cols: u32(cols) }) };
  return wrap(a);
}

export function buildCloseTerminal(terminalId: number): Message {
  const a = create(TerminalActionSchema, {});
  a.union = { case: "close", value: create(CloseTerminalSchema, { terminalId: i32(terminalId) }) };
  return wrap(a);
}

// crate::encode64 (standard alphabet, padded). Kept local so the terminal
// path does not depend on libsodium being initialised.
export function encode64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// flutter.rs handle_terminal_response. Field names and JSON types match the
// native event exactly (ints, bools), which terminal_model.dart accepts as-is.
export function terminalResponseEvent(resp: TerminalResponse): TerminalEvent | null {
  const u = resp.union;
  switch (u.case) {
    case "opened": {
      const o = u.value;
      const ev: TerminalEvent = {
        type: "opened",
        terminal_id: o.terminalId,
        success: o.success,
        message: o.message,
        pid: o.pid,
        service_id: o.serviceId,
        replay_terminal_output: o.replayTerminalOutput,
      };
      if (o.persistentSessions.length > 0) ev["persistent_sessions"] = [...o.persistentSessions];
      return ev;
    }
    case "data": {
      const d = u.value;
      // terminal_service.rs compresses chunks above a threshold with
      // hbb_common::compress (zstd) and sets `compressed`. Like
      // hbb_common::compress::decompress, a failed or oversized frame gives "".
      const bytes = d.compressed ? decompressBounded(d.data) : d.data;
      return { type: "data", terminal_id: d.terminalId, data: bytes ? encode64(bytes) : "" };
    }
    case "closed":
      return { type: "closed", terminal_id: u.value.terminalId, exit_code: u.value.exitCode };
    case "error":
      return { type: "error", terminal_id: u.value.terminalId, message: u.value.message };
    default:
      return null;
  }
}

// hbb_common::compress MAX_DECOMPRESSED_SIZE counterpart: a peer must not be
// able to blow a few KB up into gigabytes inside the console's origin.
export const MAX_DECOMPRESSED = 16 * 1024 * 1024;

/** zstd decompression that stops at `limit` bytes; null when exceeded or invalid. */
export function decompressBounded(data: Uint8Array, limit = MAX_DECOMPRESSED): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let total = 0;
  const stream = new Decompress((chunk) => {
    total += chunk.length;
    if (total > limit) throw new Error("decompressed data too large");
    parts.push(chunk);
  });
  try {
    stream.push(data, true);
  } catch {
    return null;
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// io_loop.rs check_terminal_support: null when supported, otherwise the
// msgbox to show before the connection ends.
export function terminalSupportError(
  featureTerminal: boolean,
  peerVersion: string
): { type: string; title: string; text: string } | null {
  if (featureTerminal) return null;
  if (getVersionNumber(peerVersion) < getVersionNumber("1.4.1")) {
    return {
      type: "error",
      title: "Remote terminal not supported",
      text: "Remote terminal is not supported by the remote side. Please upgrade to version 1.4.1 or higher.",
    };
  }
  return { type: "error", title: "Error", text: "Remote terminal is not supported by the remote side" };
}
