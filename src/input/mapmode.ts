// Keyboard "map" mode: port of src/keyboard.rs map_keyboard_mode for a host
// that only knows the USB HID usage of the pressed key (the Android/iOS branch
// in Rust, which is exactly the browser's situation). The peer receives its own
// platform key code in `chr` with mode = Map and applies it positionally.
import { create } from "@bufbuild/protobuf";
import { ControlKey, KeyEventSchema, KeyboardMode, type KeyEvent } from "../proto/message_pb";
import keycodes from "../proto/keycodes.json";
import { localOptions } from "../config";
import { applyLegacyModifiers } from "./keyboard";

interface Entry {
  key: string;
  win: number | null;
  linux: number | null;
  macos: number | null;
  android: number | null;
}

const TABLE = keycodes.usbHid as Record<string, Entry>;
const MAC_ISO = keycodes.macIsoSwap as { section: number | null; grave: number | null };

// keyboard.rs lock-mode bits (parse_add_lock_modes_modifiers)
const CAPS_LOCK_BIT = 1 << 1;
const NUM_LOCK_BIT = 1 << 2;

const LETTER_KEYS = new Set<string>([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => `Key${c}`),
  // is_letter_rdev_key_ex
  "LeftBracket",
  "RightBracket",
  "SemiColon",
  "Quote",
  "Comma",
  "Dot",
]);

const NUMPAD_KEYS = new Set<string>([
  "Kp0", "Kp1", "Kp2", "Kp3", "Kp4", "Kp5", "Kp6", "Kp7", "Kp8", "Kp9",
  "KpMinus", "KpMultiply", "KpDivide", "KpPlus", "KpDecimal",
]);

// Rust: peer.to_lowercase() with whitespace removed ("Mac OS" -> "macos").
export function normalizePeerPlatform(platform: string): string {
  return platform.toLowerCase().replace(/\s+/g, "");
}

export function entryForUsbHid(usbHid: number): Entry | null {
  return TABLE[String(usbHid)] ?? null;
}

// codes_conv.rs usb_hid_code_to_{win_scancode,linux_code,macos(_iso)_code,android_key_code}
export function peerCodeForUsbHid(usbHid: number, peerPlatform: string): number | null {
  const e = entryForUsbHid(usbHid);
  if (!e) return null;
  switch (normalizePeerPlatform(peerPlatform)) {
    case "windows": {
      const c = e.win;
      if (c === null) return null;
      // keyboard.rs: drop scancodes > 255 unless they carry the 0xE0 prefix
      if (c > 255 && c >> 8 !== 0xe0) return null;
      return c;
    }
    case "macos": {
      let c = e.macos;
      if (c === null) return null;
      if (localOptions.get("kb_layout") === "ISO" && MAC_ISO.section !== null && MAC_ISO.grave !== null) {
        if (c === MAC_ISO.section) c = MAC_ISO.grave;
        else if (c === MAC_ISO.grave) c = MAC_ISO.section;
      }
      return c;
    }
    case "android":
      return e.android;
    case "linux":
      return e.linux;
    default:
      // Rust falls back to the raw usb_hid for unknown peers.
      return usbHid;
  }
}

export function buildMapKeyEvent(usbHid: number, down: boolean, lockModes: number, peerPlatform: string): KeyEvent | null {
  const e = entryForUsbHid(usbHid);
  if (!e) return null;
  const platform = normalizePeerPlatform(peerPlatform);
  // keyboard.rs windows_peer_special_key: Windows has no scancode for Pause.
  if (platform === "windows" && e.key === "Pause") {
    const evt = create(KeyEventSchema, { mode: KeyboardMode.Legacy, down });
    evt.union = { case: "controlKey", value: ControlKey.Pause };
    applyLegacyModifiers(evt, { alt: false, ctrl: false, shift: false, command: false });
    return evt;
  }
  const code = peerCodeForUsbHid(usbHid, peerPlatform);
  if (code === null) return null;
  const evt = create(KeyEventSchema, { mode: KeyboardMode.Map, down });
  evt.union = { case: "chr", value: code };
  if (LETTER_KEYS.has(e.key) && (lockModes & CAPS_LOCK_BIT) !== 0) evt.modifiers.push(ControlKey.CapsLock);
  if (NUMPAD_KEYS.has(e.key) && (lockModes & NUM_LOCK_BIT) !== 0) evt.modifiers.push(ControlKey.NumLock);
  return evt;
}

// ui_session_interface.rs _handle_key_flutter_simulation: Dart sends
// name == "flutter_key" with a Flutter logical key id for media/power keys.
export function buildFlutterSimulationKey(platformCode: number, down: boolean): KeyEvent | null {
  let ck: ControlKey | null = null;
  switch (platformCode) {
    case 0x7f:
      ck = ControlKey.VolumeMute;
      break;
    case 0x80:
      ck = ControlKey.VolumeUp;
      break;
    case 0x81:
      ck = ControlKey.VolumeDown;
      break;
    case 0x66:
      ck = ControlKey.Power;
      break;
  }
  if (ck === null) return null;
  const evt = create(KeyEventSchema, { mode: KeyboardMode.Translate, down });
  evt.union = { case: "controlKey", value: ck };
  return evt;
}
