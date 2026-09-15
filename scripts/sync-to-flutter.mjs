// Recreates <rustdesk-master>/flutter/web/ (gitignored upstream) from web/ and dist/.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.RUSTDESK_SRC ?? resolve(root, "..", "rustdesk-master");
const target = resolve(src, "flutter", "web");
const dist = resolve(root, "dist", "rustdesk-web-core.js");

if (!existsSync(dist)) {
  console.error(`dist bundle missing (${dist}); run "npm run build" first.`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
cpSync(resolve(root, "web"), target, { recursive: true });
mkdirSync(resolve(target, "js"), { recursive: true });
for (const f of ["rustdesk-web-core.js", "rustdesk-web-core.js.map"]) {
  const p = resolve(root, "dist", f);
  if (existsSync(p)) cpSync(p, resolve(target, "js", f));
}
// Stale outputs from an older layout would confuse flutter build web.
rmSync(resolve(target, "js", "dist"), { recursive: true, force: true });
console.log(`synced web/ + dist/ -> ${target}`);
// Also refresh an existing flutter build output so a core-only change does not
// need a full `flutter build web`.
const built = resolve(src, "flutter", "build", "web", "js");
if (existsSync(resolve(src, "flutter", "build", "web", "index.html"))) {
  mkdirSync(built, { recursive: true });
  for (const f of ["rustdesk-web-core.js", "rustdesk-web-core.js.map"]) {
    const p = resolve(root, "dist", f);
    if (existsSync(p)) cpSync(p, resolve(built, f));
  }
  console.log(`refreshed ${built}`);
}
