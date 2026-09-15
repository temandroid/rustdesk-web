// Legacy keyboard mode: port of src/ui_session_interface.rs input_key /
// _input_key and src/client.rs KEY_MAP. Dart sends VK_* names (or a single
// character) with down/press/modifier flags.
import { create } from "@bufbuild/protobuf";
import { ControlKey, KeyEventSchema, KeyboardMode, type KeyEvent } from "../proto/message_pb";

type Key = { chr: number } | { control: ControlKey };

const chr = (c: string): Key => ({ chr: c.codePointAt(0)! });
const ck = (c: ControlKey): Key => ({ control: c });

export const KEY_MAP: Record<string, Key> = {
  VK_A: chr("a"), VK_B: chr("b"), VK_C: chr("c"), VK_D: chr("d"), VK_E: chr("e"),
  VK_F: chr("f"), VK_G: chr("g"), VK_H: chr("h"), VK_I: chr("i"), VK_J: chr("j"),
  VK_K: chr("k"), VK_L: chr("l"), VK_M: chr("m"), VK_N: chr("n"), VK_O: chr("o"),
  VK_P: chr("p"), VK_Q: chr("q"), VK_R: chr("r"), VK_S: chr("s"), VK_T: chr("t"),
  VK_U: chr("u"), VK_V: chr("v"), VK_W: chr("w"), VK_X: chr("x"), VK_Y: chr("y"),
  VK_Z: chr("z"),
  VK_0: chr("0"), VK_1: chr("1"), VK_2: chr("2"), VK_3: chr("3"), VK_4: chr("4"),
  VK_5: chr("5"), VK_6: chr("6"), VK_7: chr("7"), VK_8: chr("8"), VK_9: chr("9"),
  VK_COMMA: chr(","), VK_SLASH: chr("/"), VK_SEMICOLON: chr(";"), VK_QUOTE: chr("'"),
  VK_LBRACKET: chr("["), VK_RBRACKET: chr("]"), VK_BACKSLASH: chr("\\"),
  VK_MINUS: chr("-"), VK_PLUS: chr("="),
  VK_DIVIDE: ck(ControlKey.Divide), VK_MULTIPLY: ck(ControlKey.Multiply),
  VK_SUBTRACT: ck(ControlKey.Subtract), VK_ADD: ck(ControlKey.Add), VK_DECIMAL: ck(ControlKey.Decimal),
  VK_F1: ck(ControlKey.F1), VK_F2: ck(ControlKey.F2), VK_F3: ck(ControlKey.F3), VK_F4: ck(ControlKey.F4),
  VK_F5: ck(ControlKey.F5), VK_F6: ck(ControlKey.F6), VK_F7: ck(ControlKey.F7), VK_F8: ck(ControlKey.F8),
  VK_F9: ck(ControlKey.F9), VK_F10: ck(ControlKey.F10), VK_F11: ck(ControlKey.F11), VK_F12: ck(ControlKey.F12),
  VK_ENTER: ck(ControlKey.Return), VK_CANCEL: ck(ControlKey.Cancel), VK_BACK: ck(ControlKey.Backspace),
  VK_TAB: ck(ControlKey.Tab), VK_CLEAR: ck(ControlKey.Clear), VK_RETURN: ck(ControlKey.Return),
  VK_SHIFT: ck(ControlKey.Shift), VK_CONTROL: ck(ControlKey.Control), VK_MENU: ck(ControlKey.Alt),
  VK_PAUSE: ck(ControlKey.Pause), VK_CAPITAL: ck(ControlKey.CapsLock), VK_KANA: ck(ControlKey.Kana),
  VK_HANGUL: ck(ControlKey.Hangul), VK_JUNJA: ck(ControlKey.Junja), VK_FINAL: ck(ControlKey.Final),
  VK_HANJA: ck(ControlKey.Hanja), VK_KANJI: ck(ControlKey.Kanji), VK_ESCAPE: ck(ControlKey.Escape),
  VK_CONVERT: ck(ControlKey.Convert), VK_SPACE: ck(ControlKey.Space), VK_PRIOR: ck(ControlKey.PageUp),
  VK_NEXT: ck(ControlKey.PageDown), VK_END: ck(ControlKey.End), VK_HOME: ck(ControlKey.Home),
  VK_LEFT: ck(ControlKey.LeftArrow), VK_UP: ck(ControlKey.UpArrow), VK_RIGHT: ck(ControlKey.RightArrow),
  VK_DOWN: ck(ControlKey.DownArrow), VK_SELECT: ck(ControlKey.Select), VK_PRINT: ck(ControlKey.Print),
  VK_EXECUTE: ck(ControlKey.Execute), VK_SNAPSHOT: ck(ControlKey.Snapshot), VK_SCROLL: ck(ControlKey.Scroll),
  VK_INSERT: ck(ControlKey.Insert), VK_DELETE: ck(ControlKey.Delete), VK_HELP: ck(ControlKey.Help),
  VK_SLEEP: ck(ControlKey.Sleep), VK_SEPARATOR: ck(ControlKey.Separator),
  VK_NUMPAD0: ck(ControlKey.Numpad0), VK_NUMPAD1: ck(ControlKey.Numpad1), VK_NUMPAD2: ck(ControlKey.Numpad2),
  VK_NUMPAD3: ck(ControlKey.Numpad3), VK_NUMPAD4: ck(ControlKey.Numpad4), VK_NUMPAD5: ck(ControlKey.Numpad5),
  VK_NUMPAD6: ck(ControlKey.Numpad6), VK_NUMPAD7: ck(ControlKey.Numpad7), VK_NUMPAD8: ck(ControlKey.Numpad8),
  VK_NUMPAD9: ck(ControlKey.Numpad9),
  Apps: ck(ControlKey.Apps), Meta: ck(ControlKey.Meta), RAlt: ck(ControlKey.RAlt), RWin: ck(ControlKey.RWin),
  RControl: ck(ControlKey.RControl), RShift: ck(ControlKey.RShift),
  CTRL_ALT_DEL: ck(ControlKey.CtrlAltDel), LOCK_SCREEN: ck(ControlKey.LockScreen),
};

export interface KeyFlags {
  down: boolean;
  press: boolean;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  command: boolean;
}

function isControl(evt: KeyEvent, key: ControlKey): boolean {
  return evt.union.case === "controlKey" && evt.union.value === key;
}

// Port of keyboard::client::legacy_modifiers.
export function applyLegacyModifiers(evt: KeyEvent, f: Pick<KeyFlags, "alt" | "ctrl" | "shift" | "command">): void {
  if (f.alt && !isControl(evt, ControlKey.Alt) && !isControl(evt, ControlKey.RAlt)) evt.modifiers.push(ControlKey.Alt);
  if (f.shift && !isControl(evt, ControlKey.Shift) && !isControl(evt, ControlKey.RShift)) evt.modifiers.push(ControlKey.Shift);
  if (f.ctrl && !isControl(evt, ControlKey.Control) && !isControl(evt, ControlKey.RControl)) evt.modifiers.push(ControlKey.Control);
  if (f.command && !isControl(evt, ControlKey.Meta) && !isControl(evt, ControlKey.RWin)) evt.modifiers.push(ControlKey.Meta);
}

function keyFor(name: string): Key | null {
  const cps = Array.from(name);
  if (cps.length === 1) return chr(cps[0]!);
  return KEY_MAP[name] ?? null;
}

export function buildLegacyKeyEvent(name: string, f: KeyFlags): KeyEvent | null {
  const key = keyFor(name);
  if (!key) return null;
  const evt = create(KeyEventSchema, { mode: KeyboardMode.Legacy });
  if ("chr" in key) evt.union = { case: "chr", value: key.chr };
  else evt.union = { case: "controlKey", value: key.control };
  // _input_key: press wins over down; up sends neither flag.
  if (f.press) evt.press = true;
  else if (f.down) evt.down = true;
  applyLegacyModifiers(evt, f);
  return evt;
}

export function buildInputString(seq: string): KeyEvent {
  const evt = create(KeyEventSchema, {});
  evt.union = { case: "seq", value: seq };
  return evt;
}

// keyboard.rs event_ctrl_alt_del
export function buildCtrlAltDel(peerPlatform: string): KeyEvent {
  const evt = create(KeyEventSchema, { mode: KeyboardMode.Legacy });
  if (peerPlatform === "Windows") {
    evt.union = { case: "controlKey", value: ControlKey.CtrlAltDel };
    evt.down = true;
  } else {
    evt.union = { case: "controlKey", value: ControlKey.Delete };
    applyLegacyModifiers(evt, { alt: true, ctrl: true, shift: false, command: false });
    evt.press = true;
  }
  return evt;
}

export function buildLockScreen(): KeyEvent {
  const evt = create(KeyEventSchema, { mode: KeyboardMode.Legacy, down: true });
  evt.union = { case: "controlKey", value: ControlKey.LockScreen };
  return evt;
}
