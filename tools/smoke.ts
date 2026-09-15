// Headless protocol smoke test (no WebCodecs): rendezvous -> relay -> E2E ->
// Hash -> LoginRequest(wrong password) and print the peer's LoginResponse.
//
//   npm run smoke -- --server rustdesk.example.com --key <base64 ed25519 pk> --id 123456789 [--password x] [--insecure-ws]
//
// Uses the same session.ts as the browser, with Node's WebSocket (node >= 22)
// and a stub video sink. Run with node 22+ (`--experimental-strip-types`).
import { Session } from "../src/session";
import { initCrypto } from "../src/crypto";
import { globalOptions } from "../src/config";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) {
    const v = process.argv[i + 1];
    if (v !== undefined && !v.startsWith("--")) {
      args.set(a.slice(2), v);
      i++;
    } else args.set(a.slice(2), "true");
  }
}
const server = args.get("server");
const id = args.get("id");
if (!server || !id) {
  console.error("usage: --server <host> --id <peer id> [--key <b64>] [--password <pw>] [--insecure-ws]");
  process.exit(2);
}

// Minimal localStorage for config.ts
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
} as Storage;
(globalThis as unknown as { navigator: unknown }).navigator ??= { userAgent: "node", platform: "node" };

await initCrypto();
globalOptions.set("custom-rendezvous-server", server);
if (args.get("key")) globalOptions.set("key", args.get("key")!);
if (!args.get("insecure-ws")) globalOptions.set("api-server", `https://${server}`);

const session = new Session(
  { id, password: args.get("password") ?? "definitely-wrong-password", isSharedPassword: false },
  {
    emit(name, fields) {
      console.log(`[event] ${name}`, JSON.stringify(fields).slice(0, 300));
      if (name === "msgbox" && (fields["type"] === "error" || fields["type"] === "re-input-password" || fields["type"] === "input-password")) {
        setTimeout(() => {
          session.close();
          process.exit(fields["type"] === "error" && fields["title"] !== "Login Error" ? 1 : 0);
        }, 200);
      }
      if (name === "peer_info") {
        console.log("LOGIN OK; closing");
        setTimeout(() => {
          session.close();
          process.exit(0);
        }, 500);
      }
      if (name === "msgbox" && fields["type"]?.includes("insecure-connection")) {
        console.log("insecure connection (no/invalid key) - continuing for the smoke test");
        session.continueInsecure(true);
      }
    },
    onVideoFrame: () => false,
    onRgba: () => false,
    onClosed: () => {},
  }
);
session.start();
setTimeout(() => {
  console.error("smoke test timed out");
  process.exit(1);
}, 60_000);
