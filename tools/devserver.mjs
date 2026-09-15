// Dev server: serves the built Flutter app and proxies the RustDesk server
// endpoints through the same origin so the browser has no CORS to deal with.
//   node tools/devserver.mjs --upstream rd.example.com [--port 5179] [--root ../rustdesk-master/flutter/build/web]
//
//   /api/*      -> https://<upstream>/api/*      (HTTP proxy)
//   /ws/id      -> wss://<upstream>/ws/id        (WebSocket proxy)
//   /ws/relay   -> wss://<upstream>/ws/relay
//   everything else: static files from --root
//
// In the app set ID server = ws://localhost:<port> and API server =
// http://localhost:<port>; the core then derives both /ws/id and /ws/relay
// from that origin (proxy mode) instead of the relay host the server names.
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const here = dirname(fileURLToPath(import.meta.url));
// Optional per-machine defaults (gitignored): tools/devserver.local.json
// { "upstream": "rd.example.com", "key": "<base64 pk>", "port": 5179 }
let local = {};
try {
  local = JSON.parse(readFileSync(resolve(here, "devserver.local.json"), "utf8"));
} catch {
  /* no local defaults */
}
const upstream = arg("upstream", process.env.RD_UPSTREAM ?? local.upstream ?? "");
const port = parseInt(arg("port", process.env.RD_PORT ?? String(local.port ?? 5179)), 10);
const key = arg("key", process.env.RD_KEY ?? local.key ?? "");
const root = resolve(arg("root", resolve(here, "..", "..", "rustdesk-master", "flutter", "build", "web")));
if (!upstream) {
  console.error("--upstream <host> (or RD_UPSTREAM) is required");
  process.exit(2);
}
if (!existsSync(root)) {
  console.error(`static root not found: ${root}`);
  process.exit(2);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  if (file.endsWith("index.html")) {
    // Point the app at this proxy before Flutter starts, so no manual settings
    // are needed in whichever browser opens the page.
    const seed = `<script>(function(){var o=function(n,v){setByName('option',JSON.stringify({name:n,value:v}));};
o('custom-rendezvous-server','ws://localhost:${port}');o('api-server','http://localhost:${port}');o('relay-server','');
${key ? `o('key',${JSON.stringify(key)});` : ""}console.info('[devserver] options seeded for proxy mode');})();</script>`;
    const html = readFileSync(file, "utf8").replace("</head>", seed + "\n</head>");
    res.end(html);
    return;
  }
  createReadStream(file).pipe(res);
}

function proxyApi(req, res) {
  const headers = { ...req.headers, host: upstream };
  delete headers["origin"];
  delete headers["referer"];
  const up = httpsRequest(
    { host: upstream, port: 443, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on("error", (e) => {
    console.error("api proxy error", e.message);
    res.writeHead(502);
    res.end("upstream error");
  });
  req.pipe(up);
}

// Flutter's service worker pins js/rustdesk-web-core.js by build-time hash, so
// a refreshed core would keep being served from cache. Replace it with one that
// unregisters itself and drops its caches.
const SW_KILL = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
})()));`;

const server = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) return proxyApi(req, res);
  if (req.url?.split("?")[0] === "/harness.html") {
    // Plain-canvas test page on the same origin (shares localStorage: token + proxy settings).
    const html = readFileSync(resolve(here, "harness.html"), "utf8").replace("../dist/rustdesk-web-core.js", "/js/rustdesk-web-core.js");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
    return;
  }
  if (req.url?.split("?")[0] === "/flutter_service_worker.js") {
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
    res.end(SW_KILL);
    return;
  }
  return serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path !== "/ws/id" && path !== "/ws/relay") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const target = `wss://${upstream}${path}`;
    const up = new WebSocket(target);
    const pending = [];
    console.log(`ws ${path} -> ${target}`);
    up.on("open", () => {
      for (const m of pending.splice(0)) up.send(m);
    });
    client.on("message", (data, isBinary) => {
      const buf = isBinary ? data : Buffer.from(String(data));
      if (up.readyState === WebSocket.OPEN) up.send(buf);
      else pending.push(buf);
    });
    up.on("message", (data, isBinary) => client.send(data, { binary: isBinary }));
    const closeBoth = (why) => () => {
      try { client.close(); } catch {}
      try { up.close(); } catch {}
      console.log(`ws ${path} closed (${why})`);
    };
    client.on("close", closeBoth("client"));
    up.on("close", closeBoth("upstream"));
    client.on("error", (e) => console.error("client ws error", e.message));
    up.on("error", (e) => {
      console.error("upstream ws error", e.message);
      try { client.close(1011, "upstream error"); } catch {}
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${root}`);
  console.log(`http://localhost:${port}  (api + /ws/id + /ws/relay -> ${upstream})`);
  console.log(`index.html is served with ID server = ws://localhost:${port}, API server = http://localhost:${port}${key ? ", key set" : ", key NOT set (pass --key)"}`);
});
