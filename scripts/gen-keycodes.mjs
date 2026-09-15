// Generates src/proto/keycodes.json from the vendored rdev tables
// (tools/rdev/*.rs, rustdesk-org/rdev @ 23e24dd). Mirrors rdev codes_conv.rs:
//   usb_hid code -> Key (first match wins) -> per-platform code (first match wins)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "tools", "rdev");
const read = (f) => readFileSync(resolve(dir, f), "utf8");

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// Parse the body of decl_keycodes!(...) / decl_keycodes!{...}: rows of
// `Key, code[, code2],` with hex, decimal or kVK_* identifiers. The body runs
// from the decl_keycodes! line to the first column-0 closing bracket; comments
// inside may contain brackets, so no regex across the whole body.
function rows(src, cols) {
  const lines = src.split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));
  const start = lines.findIndex((l) => /^decl_keycodes!/.test(l));
  if (start < 0) throw new Error("decl_keycodes! not found");
  let end = lines.findIndex((l, i) => i > start && /^[)}]/.test(l));
  if (end < 0) end = lines.length;
  const out = [];
  for (const raw of lines.slice(start + 1, end)) {
    const parts = raw
      .replace(/\/\/.*$/, "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (parts.length === 0) continue;
    if (parts.length !== cols) throw new Error(`expected ${cols} columns, got ${parts.length}: ${raw}`);
    out.push(parts);
  }
  return out;
}

const macVk = {};
for (const m of read("macos_virtual_keycodes.rs").matchAll(/pub const (kVK_[A-Za-z0-9_]+): CGKeyCode = (0x[0-9a-fA-F]+|\d+);/g)) {
  macVk[m[1]] = Number(m[2]);
}
const num = (v) => (v.startsWith("kVK_") ? macVk[v] : Number(v));

const usb = rows(read("usb_hid.rs"), 2); // [Key, usb]
const win = rows(read("windows.rs"), 3); // [Key, vk, scancode]
const linux = rows(read("linux.rs"), 2);
const macos = rows(read("macos.rs"), 2);
const android = rows(read("android.rs"), 2);

// key -> code, first occurrence wins (Rust match arm order)
const firstByKey = (tbl, idx) => {
  const m = new Map();
  for (const r of tbl) if (!m.has(r[0])) m.set(r[0], num(r[idx]));
  return m;
};
const winByKey = firstByKey(win, 2);
const linuxByKey = firstByKey(linux, 1);
const macByKey = firstByKey(macos, 1);
const androidByKey = firstByKey(android, 1);

// codes_conv.rs macos_target_code_from_key: JIS keys share the input-mode positions
if (macVk.kVK_JIS_Eisu !== undefined) macByKey.set("NonConvert", macVk.kVK_JIS_Eisu);
if (macVk.kVK_JIS_Kana !== undefined) macByKey.set("Convert", macVk.kVK_JIS_Kana);

// usb code -> Key, first occurrence wins
const keyByUsb = new Map();
for (const [key, code] of usb) {
  const c = num(code);
  if (!keyByUsb.has(c)) keyByUsb.set(c, key);
}

const table = {};
for (const [code, key] of keyByUsb) {
  table[code] = {
    key,
    win: winByKey.get(key) ?? null,
    linux: linuxByKey.get(key) ?? null,
    macos: macByKey.get(key) ?? null,
    android: androidByKey.get(key) ?? null,
  };
}

const out = {
  source: "rustdesk-org/rdev@23e24dd6b35452a495dae0ae6d99395e9755ab0f",
  macIsoSwap: { section: macVk.kVK_ISO_Section ?? null, grave: macVk.kVK_ANSI_Grave ?? null },
  usbHid: table,
};
mkdirSync(resolve(root, "src", "proto"), { recursive: true });
writeFileSync(resolve(root, "src", "proto", "keycodes.json"), JSON.stringify(out) + LF);
const check = (c) => `${c.toString(16)}:${JSON.stringify(table[c])}`;
console.log(`keycodes.json: ${Object.keys(table).length} usb-hid entries; Enter ${check(0x28)}; Backspace ${check(0x2a)}`);
