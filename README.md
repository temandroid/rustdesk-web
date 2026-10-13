# rustdesk-web

Browser client for a self-hosted RustDesk server, served from your own domain.
It is the Flutter web shell of [RustDesk](https://github.com/rustdesk/rustdesk)
plus the open TypeScript core from
[rustdesk-web-core](https://github.com/quietlydismantled/rustdesk-web-core),
whose history this repository keeps. Licensed under **AGPL-3.0-only**; see
[NOTICE](NOTICE) for what comes from where.

Changes in this fork:

- upstream RustDesk pinned in [`RUSTDESK_REF`](RUSTDESK_REF) instead of `master`;
- `scripts/build-release.sh` and CI that publish a static bundle
  (`rustdesk-web.tar.gz`, base href `/web/`, no CDN resources) on every `v*` tag;
- a "Source (AGPL-3.0)" link on the page pointing at the exact commit served;
- original icons, the rdev MIT licence text, NOTICE;
- Russian UI (`src/lang/ru.rs` of the pinned tree, `src/lang.ts`);
- sound: Opus via WebCodecs `AudioDecoder` played through an AudioContext
  (`src/audio.ts`, port of `client.rs` AudioHandler); "Mute" in the toolbar works.

The hosting server renders `rd-config.js` (ID server, API server, key) and must
proxy `/api`, `/ws/id` and `/ws/relay` on the same origin.

---

## Upstream README (rustdesk-web-core)

Open TypeScript viewer core for the RustDesk Flutter web shell. RustDesk's own
"Web Client V2 (Preview)" ships only the Dart half in the public repo; the JS
core behind `setByName` / `getByName` / `window.onVideoFrame` is not published.
This project implements that contract in the open, against the peer protocol in
`rustdesk-master/libs/base/protos/message.proto` and the rendezvous protocol
from `hbb_common`.

Scope of this MVP (relay-only):

- connect by ID through hbbs (`/ws/id`) and hbbr (`/ws/relay`) over WebSocket
- end-to-end encryption with the peer (ed25519 identity, X25519 box, XSalsa20-Poly1305)
- password / 2FA login, insecure-connection confirmation
- video via WebCodecs (VP8, VP9, AV1, H264, H265 when the browser supports them)
- mouse and keyboard (map mode via rdev usb-hid tables, legacy mode), display
  switching, image quality, codec preference, remote cursor, quality monitor
- chat, text clipboard both ways (local side polled via `navigator.clipboard`
  while the tab is focused; the browser asks once for read permission)
- file transfer: browse, download (File System Access API when available,
  otherwise browser downloads), upload from a file/folder picker, delete,
  create folder, rename, cancel, overwrite confirmation

- WebRTC P2P (data channel): the offer rides in the punch request, ICE
  candidates trickle through the ID server, a P2P result is preferred over an
  established relay within RustDesk's 2.5 s window, and the peer's signed DTLS
  fingerprint is bound to its identity (fail closed, fall back to relay).
  Needs a peer and an ID server built after RustDesk PR #15684 (September
  2026); older ones ignore the offer and the session stays on the relay.

- terminal (beta, as in upstream): the upstream web TerminalPage over a
  TERMINAL connection; open/input/resize/close, zstd-compressed output,
  persistent sessions (service id), "run as administrator" with OS login.
  Needs a peer with the terminal feature (RustDesk 1.4.1+).

Not yet: port forward, transfer resume. (Audio: added in this fork.)

## Layout

```
proto/rendezvous.proto      vendored from rustdesk/hbb_common (submodule is empty in the zip export)
scripts/gen-proto.mjs       copies libs/base/protos/message.proto, runs buf generate (protoc-gen-es)
scripts/gen-lang.mjs        src/lang/en.rs -> src/proto/lang_en.json
scripts/sync-to-flutter.mjs recreates rustdesk-master/flutter/web/ from web/ + dist/
src/index.ts                installs window.init / isMobile / setByName / getByName
src/bridge.ts               name -> handler tables, event channels (onGlobalEvent, onRegisteredEvent)
src/session.ts              relay-only session state machine (port of src/client.rs + io_loop.rs)
src/transport/ws.ts         one WS binary message == one protobuf; secretbox after set_key
src/transport/webrtc.ts     RTCPeerConnection data channel "bootstrap", 1-byte fragment framing (webrtc.rs)
src/sessions.ts             concurrent remote + file-transfer sessions, per-page callback capture
src/filetransfer.ts, src/clipboard.ts
src/crypto.ts               libsodium: sign_open, box seal (zero nonce), secretbox with LE u64 counter nonce
src/video/webcodecs.ts      per-display VideoDecoder, zero-copy handoff to Dart or RGBA fallback
src/input/{mouse,keyboard}.ts
src/config.ts               localStorage stores replacing Config/LocalConfig/PeerConfig
web/                        flutter/web template (index.html loads js/rustdesk-web-core.js first)
tools/smoke.ts              headless Node protocol test against a real server
test/                       vitest unit tests (crypto vectors, mask math, url mapping, key map)
```

## Build

```
npm ci
npm run build        # gen-proto + tsc --noEmit + vite build -> dist/rustdesk-web-core.js
npm test
npm run sync         # -> ../rustdesk-master/flutter/web/
```

`RUSTDESK_SRC` overrides the sibling `rustdesk-master` location.

Then the Flutter shell (Flutter 3.24.5, the version pinned in
`.github/workflows/flutter-build.yml`):

```
cd ../rustdesk-master/flutter
flutter pub get
flutter build web --release --web-renderer canvaskit
```

Serve `flutter/build/web/` from the same origin as the RustDesk server (or any
https origin). CanvasKit is preferred: the zero-copy video path uses
`ui_web.createImageFromTextureSource`; other renderers fall back to RGBA.

Dev loop without rebuilding Flutter each time: `npm run watch` in one shell and
replace `flutter/build/web/js/rustdesk-web-core.js` (or point a junction from
`flutter/web/js` to `web-core/dist`) and reload the page.

## Server side (rustdesk-server-pro)

The core expects the same endpoints the native client uses in WebSocket mode:

| page / api-server | ID server option | rendezvous URL           | relay URL                    |
|-------------------|------------------|--------------------------|------------------------------|
| https             | `rd.example.com` | `wss://rd.example.com/ws/id` | `wss://rd.example.com/ws/relay` |
| http              | `rd.example.com` | `ws://rd.example.com/ws/id`  | `ws://rd.example.com/ws/relay`  |
| any               | `10.0.0.5:21116` | `ws://10.0.0.5:21118`    | `ws://10.0.0.5:21119`        |

Reverse proxy: `/ws/id` -> hbbs `:21118`, `/ws/relay` -> hbbr `:21119`
(HTTP/1.1 upgrade, long read timeout, allow multi-hundred-KB frames). Firewall
21118/21119 to the proxy only; hbbs/hbbr trust `X-Forwarded-For` unvalidated.

Settings the user must enter in the web UI (or seed through `setByName('option', ...)`):

- `custom-rendezvous-server`: the ID server host
- `key`: the server's public key (`id_ed25519.pub`). Without it every session
  is "insecure" and the UI asks for confirmation.
- `api-server`: `https://...` forces `wss://` even when the page is served over http.

## Upstream shell patches

`patches/rustdesk-web-shell.patch` holds the two small Dart changes the web
shell needs (a "Transfer file" toolbar entry on web, and a file-manager back
action that pops only its own page). Apply once to the RustDesk source tree:

```
cd ../rustdesk-master && git apply ../web-core/patches/rustdesk-web-shell.patch
```

## Dev proxy (no CORS, no nginx changes)

The Pro API sends no `Access-Control-Allow-Origin` header and answers `OPTIONS`
with 405, so a page on another origin cannot call `/api/login`. For development
serve the built app through `tools/devserver.mjs`, which proxies `/api/*`,
`/ws/id` and `/ws/relay` to the Pro host on the same origin (and replaces
Flutter's service worker so a refreshed core is never served from cache):

```
node tools/devserver.mjs --upstream rd.example.com --key <base64 pk> --port 5179
# or: copy tools/devserver.local.example.json to tools/devserver.local.json
#     (gitignored) and run `npm run serve`
```

In the app settings use ID server `ws://localhost:5179`, API server
`http://localhost:5179`, key = server public key. An explicit `ws(s)://` ID
server is "proxy mode": the core derives `/ws/id` and `/ws/relay` from that
origin and ignores the relay host the server names. Log in under Settings ->
Account first: rustdesk-server-pro refuses punch requests without a login token
("You have not logged in or your login session has expired").

For production put `flutter/build/web` behind the same nginx as the API.

## Docker

`Dockerfile` builds the whole thing (core, patched Flutter shell, nginx) and
needs nothing installed locally except Docker:

```
docker build -t rustdesk-web-core .                       # RustDesk master
docker build --build-arg RUSTDESK_REF=<tag-or-commit> -t rustdesk-web-core .
docker run -p 8080:80 -e RD_ID_SERVER=rd.example.com -e RD_API_SERVER=https://rd.example.com -e RD_KEY=<pk> rustdesk-web-core
```

The container serves static files only. Environment variables are rendered
into `/rd-config.js` at start (`docker/10-rd-config.sh`) and applied by the
core as defaults for settings the user has not changed (`RD_FORCE_CONFIG=true`
overrides on every load):

| variable          | meaning                                                              |
|-------------------|----------------------------------------------------------------------|
| `RD_ID_SERVER`    | ID server host; domain form maps to `wss://host/ws/id` and `/ws/relay` |
| `RD_API_SERVER`   | `https://...` origin of the RustDesk HTTP API (login, address book)   |
| `RD_KEY`          | server public key (`id_ed25519.pub`)                                  |
| `RD_RELAY_SERVER` | optional relay host                                                   |
| `RD_ICE_SERVERS`  | optional comma separated `stun:` / `turn://user:pass@host:port` list |

Because the Pro API sends no CORS headers, the web client must share an origin
with the API and WebSocket endpoints. `deploy/swag/rustdesk-web.subdomain.conf`
does that with SWAG: one subdomain, `/` to this container, `/api/` to hbbs
21114, `/ws/id` to hbbs 21118, `/ws/relay` to hbbr 21119.
`deploy/docker-compose.yml` is the matching service definition; set
`RD_ID_SERVER`/`RD_API_SERVER` to that subdomain.

## Smoke test (no browser, no Flutter)

```
npm run smoke -- --server rd.example.com --key <base64 pk> --id 123456789 --password wrong
```

Expected: `connection_ready {secure:true}`, `fingerprint`, then a `re-input-password`
msgbox ("Wrong Password") from the peer. With the right password: `peer_info` and exit 0.

## Bridge contract (what Dart calls)

See `flutter/lib/web/bridge.dart`; the implemented names are the `case` labels
in `src/bridge.ts`. Events go out as JSON strings with every value a string:
`onGlobalEvent` for session events (`msgbox`, `peer_info`, `switch_display`,
`cursor_*`, `permission`, `connection_ready`, `fingerprint`,
`update_quality_status`, ...) and `onRegisteredEvent` for `load_recent_peers`,
`load_fav_peers`, `callback_query_onlines`.

## WebRTC notes

- ICE servers come from the global option `ice-servers` (comma separated
  `stun:`/`turn://user:pass@host:port` URLs, same as Rust); the four public
  STUN servers RustDesk uses are added when no STUN entry is configured.
- The offer is a trickle offer (`webrtc://` + base64 JSON `{type, sdp,
  ice_policy: "all"}`); candidates go as `IceCandidate{id, session_key,
  candidate}` on the same rendezvous socket the punch request used, re-sent once
  after 400 ms; the peer's candidates arrive there too.
- `tools/webrtc-loopback.html` (served by the `harness` server) exercises the
  transport with an offerer and answerer in one page.
- Toggle: Settings -> General -> "Enable WebRTC P2P connection" (local option
  `enable-webrtc`; unset means on).

## Provenance of protocol facts

- WebSocket framing / URL mapping: `hbb_common/src/websocket.rs`
- per-message encryption: `hbb_common/src/tcp.rs` (`Encrypt`)
- handshake: `rustdesk-master/src/client.rs` (`secure_connection`, `create_relay`, `request_relay`)
- password hashing: `src/client.rs` `handle_hash` / `handle_login_from_ui`
- event field names: `src/flutter.rs`
- mouse mask: `src/flutter_ffi.rs` `session_send_mouse`
- online states bitmask: `src/client.rs` (`0x01 << (7 - i % 8)`)
- WebRTC: `hbb_common/src/webrtc.rs` (envelope, framing, fingerprint), `src/client.rs`
  (`spawn_webrtc_ice_bridge`, `race_transports_prefer_webrtc`, `secure_connection`)
