// Copies message.proto from the sibling rustdesk-master checkout next to the
// vendored rendezvous.proto, then runs buf generate (protoc-gen-es).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src =
  process.env.RUSTDESK_SRC ?? resolve(root, "..", "rustdesk-master");
const messageProto = resolve(src, "libs", "base", "protos", "message.proto");
if (!existsSync(messageProto)) {
  console.error(`message.proto not found at ${messageProto}. Set RUSTDESK_SRC.`);
  process.exit(1);
}
mkdirSync(resolve(root, "src", "proto"), { recursive: true });
copyFileSync(messageProto, resolve(root, "proto", "message.proto"));

// Record the client version next to the generated code so version.ts stays in sync.
const cargo = readFileSync(resolve(src, "Cargo.toml"), "utf8");
const m = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
if (m) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    resolve(root, "src", "proto", "version.json"),
    JSON.stringify({ version: m[1] }, null, 2) + "\n"
  );
}

const bin = process.platform === "win32" ? "buf.cmd" : "buf";
const r = spawnSync(resolve(root, "node_modules", ".bin", bin), ["generate"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
