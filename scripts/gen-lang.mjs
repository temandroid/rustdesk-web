// Extracts ("key", "value") pairs from src/lang/<lang>.rs into
// src/proto/lang_<lang>.json for every language in LANGS (see src/lang.ts).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LANGS = ["en", "ru"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.RUSTDESK_SRC ?? resolve(root, "..", "rustdesk-master");
const re = /\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g;
const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

mkdirSync(resolve(root, "src", "proto"), { recursive: true });
for (const lang of LANGS) {
  const text = readFileSync(resolve(src, "src", "lang", `${lang}.rs`), "utf8");
  const out = {};
  let m;
  while ((m = re.exec(text))) out[unescape(m[1])] = unescape(m[2]);
  writeFileSync(resolve(root, "src", "proto", `lang_${lang}.json`), JSON.stringify(out, null, 1) + "\n");
  console.log(`lang_${lang}.json: ${Object.keys(out).length} entries`);
}
