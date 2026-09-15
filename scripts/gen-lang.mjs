// Extracts ("key", "value") pairs from src/lang/en.rs into src/proto/lang_en.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.RUSTDESK_SRC ?? resolve(root, "..", "rustdesk-master");
const en = readFileSync(resolve(src, "src", "lang", "en.rs"), "utf8");
const out = {};
const re = /\("((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"\)/g;
let m;
while ((m = re.exec(en))) {
  const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  out[unescape(m[1])] = unescape(m[2]);
}
mkdirSync(resolve(root, "src", "proto"), { recursive: true });
writeFileSync(resolve(root, "src", "proto", "lang_en.json"), JSON.stringify(out, null, 1) + "\n");
console.log(`lang_en.json: ${Object.keys(out).length} entries`);
