// Port of src/flutter_ffi.rs session_send_mouse + src/client.rs send_mouse.
import { create } from "@bufbuild/protobuf";
import { ControlKey, MouseEventSchema, type MouseEvent as PbMouseEvent } from "../proto/message_pb";

export const MOUSE_TYPE_MOVE = 0;
export const MOUSE_TYPE_DOWN = 1;
export const MOUSE_TYPE_UP = 2;
export const MOUSE_TYPE_WHEEL = 3;
export const MOUSE_TYPE_TRACKPAD = 4;
export const MOUSE_TYPE_MOVE_RELATIVE = 5;

export const MOUSE_BUTTON_LEFT = 1;
export const MOUSE_BUTTON_RIGHT = 2;
export const MOUSE_BUTTON_WHEEL = 4;
export const MOUSE_BUTTON_BACK = 8;
export const MOUSE_BUTTON_FORWARD = 16;

export type MouseJson = Record<string, string>;

export interface MouseOptions {
  swapLeftRight?: boolean;
}

function parseInt0(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// Returns null when the message must be dropped (invalid relative-mode marker
// or the local-only "disable" marker).
export function buildMouseEvent(m: MouseJson, opts: MouseOptions = {}): PbMouseEvent | null {
  const rel = m["relative_mouse_mode"];
  if (rel !== undefined) {
    const active = rel === "1" || rel === "Y" || rel === "on";
    if (!active) return null;
    if (m["type"] !== "move_relative") return null;
    if (parseInt0(m["x"]) !== 0 || parseInt0(m["y"]) !== 0) return null;
    if ("buttons" in m || "alt" in m || "ctrl" in m || "shift" in m || "command" in m) return null;
  }
  let mask = 0;
  switch (m["type"]) {
    case "down":
      mask = MOUSE_TYPE_DOWN;
      break;
    case "up":
      mask = MOUSE_TYPE_UP;
      break;
    case "wheel":
      mask = MOUSE_TYPE_WHEEL;
      break;
    case "trackpad":
      mask = MOUSE_TYPE_TRACKPAD;
      break;
    case "move_relative":
      mask = MOUSE_TYPE_MOVE_RELATIVE;
      break;
    default:
      mask = MOUSE_TYPE_MOVE;
  }
  let button = 0;
  switch (m["buttons"]) {
    case "left":
      button = MOUSE_BUTTON_LEFT;
      break;
    case "right":
      button = MOUSE_BUTTON_RIGHT;
      break;
    case "wheel":
      button = MOUSE_BUTTON_WHEEL;
      break;
    case "back":
      button = MOUSE_BUTTON_BACK;
      break;
    case "forward":
      button = MOUSE_BUTTON_FORWARD;
      break;
  }
  if (opts.swapLeftRight) {
    if (button === MOUSE_BUTTON_LEFT) button = MOUSE_BUTTON_RIGHT;
    else if (button === MOUSE_BUTTON_RIGHT) button = MOUSE_BUTTON_LEFT;
  }
  mask |= button << 3;

  // Same push order as Rust: Alt, Shift, Control, Meta.
  const modifiers: ControlKey[] = [];
  if ("alt" in m) modifiers.push(ControlKey.Alt);
  if ("shift" in m) modifiers.push(ControlKey.Shift);
  if ("ctrl" in m) modifiers.push(ControlKey.Control);
  if ("command" in m) modifiers.push(ControlKey.Meta);

  return create(MouseEventSchema, {
    mask,
    x: parseInt0(m["x"]),
    y: parseInt0(m["y"]),
    modifiers,
  });
}
