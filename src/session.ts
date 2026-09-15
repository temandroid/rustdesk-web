// Controller session: relay-only port of src/client.rs (_start_inner, connect,
// request_relay, create_relay, secure_connection, handle_hash/handle_login_*)
// and src/client/io_loop.rs (handle_msg_from_peer), reduced to what the Flutter
// web shell needs for view + input.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { decompress as zstdDecompress } from "fzstd";
import {
  ConnType,
  IdPkSchema,
  NatType,
  PunchHoleRequestSchema,
  PunchHoleResponse_Failure,
  type PunchHoleResponse,
  type RelayResponse,
  RelayResponseSchema,
  RendezvousMessageSchema,
  RequestRelaySchema,
} from "./proto/rendezvous_pb";
import {
  Auth2FASchema,
  CaptureDisplaysSchema,
  ChatMessageSchema,
  FileTransferSchema,
  type DisplayInfo,
  ImageQuality,
  type KeyEvent,
  LoginRequestSchema,
  type Message,
  MessageSchema,
  MiscSchema,
  type Misc,
  type MouseEvent as PbMouseEvent,
  OptionMessageSchema,
  OptionMessage_BoolOption,
  type OptionMessage,
  type PeerInfo,
  PermissionInfo_Permission,
  PublicKeySchema,
  type SupportedDecoding,
  SwitchDisplaySchema,
  type SwitchDisplay,
  type TestDelay,
  type Hash,
} from "./proto/message_pb";
import { WsStream, WsTimeoutError, buildWsUrlCandidates, connectFirst, isExplicitWsEndpoint, pageIsHttps, splitHostPort } from "./transport/ws";
import {
  createSymmetricKeyMsg,
  decodeBase64,
  pkToFingerprint,
  sha256,
  signOpen,
} from "./crypto";
import {
  PeerStore,
  accessToken,
  apiServer,
  localOptions,
  myId,
  myName,
  localOs,
  relayServerOption,
  rendezvousServer,
  serverKey,
} from "./config";
import { VERSION, isSupportMultiUiSession } from "./version";
import { VideoPipeline, type CodecAbilities, type CodecName, buildSupportedDecoding, probeCodecs } from "./video/webcodecs";
import { buildMouseEvent, type MouseJson } from "./input/mouse";
import { buildFlutterSimulationKey, buildMapKeyEvent } from "./input/mapmode";
import {
  buildCtrlAltDel,
  buildInputString,
  buildLegacyKeyEvent,
  buildLockScreen,
  type KeyFlags,
} from "./input/keyboard";
import { ClipboardWatcher, buildClipboardMessage, textFromClipboards } from "./clipboard";
import { FileTransfer } from "./filetransfer";
import { log } from "./log";

// hbb_common::config
const CONNECT_TIMEOUT = 18_000;
const READ_TIMEOUT = 18_000;
// io_loop.rs: 30 s without any message from the peer -> "Timeout"
const PEER_IDLE_TIMEOUT = 30_000;
// rustdesk public server key, used when option `key` is empty (config::RS_PUB_KEY)
const RS_PUB_KEY = "OeVuKk5nlHiXp+APNn0Y3pC1Iwpwn44JGqrQCsWqmBw=";

const LOGIN_MSG_PASSWORD_EMPTY = "Empty Password";
const LOGIN_MSG_PASSWORD_WRONG = "Wrong Password";
const LOGIN_MSG_2FA_WRONG = "Wrong 2FA Code";
const REQUIRE_2FA = "2FA Required";

export type Fields = Record<string, string>;

export interface SessionHost {
  emit(name: string, fields: Fields): void;
  // Salted password hash of another live session to the same peer (e.g. the
  // remote session under a file-transfer page), so a nested session does not
  // prompt again. Rust reuses config.password the same way.
  siblingHashedPassword?(): Uint8Array | null;
  onVideoFrame(display: number, frame: VideoFrame): boolean;
  onRgba(display: number, rgba: Uint8Array, width: number, height: number): boolean;
  onClosed(session: Session): void;
}

export interface SessionOptions {
  id: string;
  password: string; // raw password passed by the UI (may be empty)
  isSharedPassword: boolean;
  connType?: ConnType;
}

type State =
  | "idle"
  | "rendezvous"
  | "relay"
  | "securing"
  | "wait-hash"
  | "logging-in"
  | "connected"
  | "closed";

function u8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function jsonStr(v: unknown): string {
  return JSON.stringify(v);
}

export class Session {
  readonly id: string;
  private state: State = "idle";
  private ws: WsStream | null = null;
  private secured = false;
  private peerSignPk: Uint8Array | null = null;
  private hash: Hash | null = null;
  // SHA256(password || salt); what Rust keeps as `lc.password` / config.password
  private hashedPassword: Uint8Array | null = null;
  private rawPassword: string;
  private remember = false;
  private peerInfo: PeerInfo | null = null;
  private displays: DisplayInfo[] = [];
  private currentDisplay = 0;
  private readonly peer: PeerStore;
  private abilities: CodecAbilities = { vp8: true, vp9: true, av1: false, h264: false, h265: false };
  private unsupported = new Set<CodecName>();
  private video: VideoPipeline;
  private lastKeyframeRequest = new Map<number, number>();
  private qualityTimer: number | null = null;
  private lastDelay = 0;
  private targetBitrate = 0;
  private codecFormat = "";
  private insecureDecision: ((ok: boolean) => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  // client.rs: one session_id per connection, reused across login retries
  private readonly sessionId: bigint = randomU64();
  // io_loop.rs server_clipboard_enabled / server_keyboard_enabled (Permission events)
  private serverClipboardEnabled = true;
  private serverKeyboardEnabled = true;
  private clipboardWatcher: ClipboardWatcher | null = null;
  readonly connType: ConnType;
  readonly fileTransfer: FileTransfer;
  enableTrustedDevices = false;

  constructor(opts: SessionOptions, private readonly host: SessionHost) {
    this.id = opts.id;
    this.rawPassword = opts.password;
    this.connType = opts.connType ?? ConnType.DEFAULT_CONN;
    this.peer = new PeerStore(opts.id);
    this.fileTransfer = new FileTransfer({
      emit: (n, f) => this.host.emit(n, f),
      send: (m) => this.sendMessage(m),
      bufferedAmount: () => this.ws?.bufferedAmount ?? 0,
      peerPlatform: () => this.peerPlatform,
      peerVersion: () => this.peerVersion,
    });
    this.video = new VideoPipeline({
      onVideoFrame: (d, f) => this.host.onVideoFrame(d, f),
      onRgba: (d, rgba, w, h) => this.host.onRgba(d, rgba, w, h),
      expectedSize: (d) => {
        const di = this.displays[d];
        return di ? { width: di.width, height: di.height } : null;
      },
      onDecoderError: (d, codec, err) => this.onDecoderError(d, codec, err),
      requestKeyframe: (d) => this.requestKeyframe(d),
    });
  }

  get peerPlatform(): string {
    return this.peerInfo?.platform ?? "";
  }

  get peerVersion(): string {
    return this.peerInfo?.version ?? "";
  }

  get hasRememberedPassword(): boolean {
    return this.peer.getHashedPassword() !== null;
  }

  // SHA256(password || salt) once known; the salt is per peer, so it is valid
  // for any session to the same peer.
  get currentHashedPassword(): Uint8Array | null {
    return this.hashedPassword;
  }

  get isConnected(): boolean {
    return this.state === "connected";
  }

  get isFileTransfer(): boolean {
    return this.connType === ConnType.FILE_TRANSFER;
  }

  // Kept as a method: TS control-flow narrowing of `this.state` does not reset
  // across awaits, so an inline comparison after an assignment is flagged.
  private isClosed(): boolean {
    return (this.state as State) === "closed";
  }

  // ---- lifecycle -----------------------------------------------------------

  get hasStarted(): boolean {
    return this.state !== "idle";
  }

  start(): void {
    if (this.state !== "idle") return;
    this.loopPromise = this.run().catch((e) => this.fail(e));
  }

  close(sendReason = true): void {
    if (this.state === "closed") return;
    const wasConnected = this.state === "connected" || this.state === "logging-in" || this.state === "wait-hash";
    this.state = "closed";
    if (wasConnected && sendReason) {
      try {
        const misc = create(MiscSchema, {});
        misc.union = { case: "closeReason", value: "" };
        this.sendMisc(misc);
      } catch {
        /* ignore */
      }
    }
    this.stopQualityTimer();
    this.clipboardWatcher?.stop();
    this.clipboardWatcher = null;
    this.fileTransfer.close();
    this.video.close();
    this.ws?.close();
    this.ws = null;
    this.insecureDecision?.(false);
    this.insecureDecision = null;
    this.host.onClosed(this);
  }

  private fail(e: unknown): void {
    if (this.state === "closed") return;
    const text = e instanceof Error ? e.message : String(e);
    log.error("session error", e);
    this.msgbox("error", "Connection Error", text);
    this.close(false);
  }

  private msgbox(type: string, title: string, text: string, link = ""): void {
    const hasRetry = checkIfRetry(type, title, text);
    this.host.emit("msgbox", { type, title, text, link, hasRetry: hasRetry ? "true" : "" });
  }

  // ---- connection ----------------------------------------------------------

  private secureWs(): boolean {
    return pageIsHttps() || apiServer().toLowerCase().startsWith("https");
  }

  private rendezvousHost(): string {
    const s = rendezvousServer();
    if (!s) throw new Error("No ID server configured. Set the ID server and key in settings.");
    return s;
  }

  private async run(): Promise<void> {
    this.abilities = await probeCodecs();
    this.state = "rendezvous";
    const rsHost = this.rendezvousHost();
    const idUrls = buildWsUrlCandidates(rsHost, "id", { secure: this.secureWs() });
    log.info(`connecting to rendezvous ${idUrls.join(" | ")} for ${this.id}`);
    const rs = await connectFirst(idUrls, CONNECT_TIMEOUT);
    let signedIdPk: Uint8Array = new Uint8Array();
    let relayServer = "";
    let uuid = "";
    try {
      const resp = await this.punchHole(rs);
      if ("relay" in resp) {
        const rr = resp.relay;
        if (rr.refuseReason) throw new Error(rr.refuseReason);
        if (rr.union.case === "pk") signedIdPk = rr.union.value;
        relayServer = rr.relayServer;
        uuid = rr.uuid;
      } else {
        const phr = resp.punch;
        signedIdPk = phr.pk;
        relayServer = phr.relayServer;
        // Peer answered the punch request but we cannot punch from a browser:
        // ask the rendezvous server to broker a relay session (request_relay).
        rs.close();
        const rr = await this.requestRelay(rsHost, relayServer, signedIdPk.length > 0);
        if (rr.refuseReason) throw new Error(rr.refuseReason);
        if (rr.relayServer) relayServer = rr.relayServer;
        uuid = rr.uuid;
      }
    } finally {
      rs.close();
    }
    if (this.isClosed()) return;

    this.state = "relay";
    // Proxy mode: the same origin fronts /ws/relay, ignore the relay host the
    // server named (it is the upstream's own address, unreachable via CORS-free path).
    const relayTarget = isExplicitWsEndpoint(rsHost)
      ? rsHost
      : relayServer || relayServerOption() || splitHostPort(rsHost).host;
    const relayUrls = buildWsUrlCandidates(relayTarget, "relay", { secure: this.secureWs() });
    log.info(`connecting to relay ${relayUrls.join(" | ")}`);
    const conn = await connectFirst(relayUrls, CONNECT_TIMEOUT);
    if (this.isClosed()) {
      conn.close();
      return;
    }
    this.ws = conn;
    conn.onClose = (e) => {
      if (this.state !== "closed") this.fail(e);
    };
    // create_relay: first message on the relay socket
    const rr = create(RendezvousMessageSchema, {});
    rr.union = {
      case: "requestRelay",
      value: create(RequestRelaySchema, {
        licenceKey: serverKey(),
        id: this.id,
        uuid,
        connType: this.connType,
      }),
    };
    conn.send(toBinary(RendezvousMessageSchema, rr));

    this.state = "securing";
    await this.secureConnection(conn, signedIdPk);
    if (this.isClosed()) return;
    this.host.emit("connection_ready", {
      secure: this.secured ? "true" : "false",
      direct: "false",
      stream_type: "WebSocket",
    });
    if (this.peerSignPk) {
      this.host.emit("fingerprint", { fingerprint: pkToFingerprint(this.peerSignPk) });
    }
    if (!this.secured) {
      const ok = await this.confirmInsecure();
      if (!ok) {
        this.close(false);
        return;
      }
    }
    this.state = "wait-hash";
    await this.msgLoop(conn);
  }

  private async punchHole(rs: WsStream): Promise<{ relay: RelayResponse } | { punch: PunchHoleResponse }> {
    const req = create(RendezvousMessageSchema, {});
    req.union = {
      case: "punchHoleRequest",
      value: create(PunchHoleRequestSchema, {
        id: this.id,
        token: accessToken(),
        natType: NatType.SYMMETRIC,
        licenceKey: serverKey(),
        connType: this.connType,
        version: VERSION,
        forceRelay: true,
      }),
    };
    const bytes = toBinary(RendezvousMessageSchema, req);
    // client.rs: up to 3 requests with 3/6/9 s deadlines
    for (let attempt = 1; attempt <= 3; attempt++) {
      rs.send(bytes);
      const deadline = Date.now() + attempt * 3000;
      while (Date.now() < deadline) {
        let raw: Uint8Array;
        try {
          raw = await rs.next(Math.max(1, deadline - Date.now()));
        } catch (e) {
          if (e instanceof WsTimeoutError) break;
          throw e;
        }
        const msg = fromBinary(RendezvousMessageSchema, raw);
        switch (msg.union.case) {
          case "punchHoleResponse": {
            const phr = msg.union.value;
            if (phr.socketAddr.length === 0) {
              throw new Error(punchFailureText(phr));
            }
            return { punch: phr };
          }
          case "relayResponse":
            return { relay: msg.union.value };
          default:
            // KeyExchange / IceCandidate / others: irrelevant for relay-only
            continue;
        }
      }
    }
    throw new Error("Timeout");
  }

  // client.rs request_relay: fresh rendezvous socket, RequestRelay, wait RelayResponse.
  private async requestRelay(rsHost: string, relayServer: string, secure: boolean): Promise<RelayResponse> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const rs = await connectFirst(buildWsUrlCandidates(rsHost, "id", { secure: this.secureWs() }), CONNECT_TIMEOUT);
      try {
        const uuid = crypto.randomUUID();
        const msg = create(RendezvousMessageSchema, {});
        msg.union = {
          case: "requestRelay",
          value: create(RequestRelaySchema, {
            id: this.id,
            token: accessToken(),
            uuid,
            relayServer,
            secure,
            connType: this.connType,
          }),
        };
        rs.send(toBinary(RendezvousMessageSchema, msg));
        const raw = await rs.next(CONNECT_TIMEOUT);
        const resp = fromBinary(RendezvousMessageSchema, raw);
        if (resp.union.case === "relayResponse") {
          const rr = resp.union.value;
          if (!rr.uuid) rr.uuid = uuid;
          return rr;
        }
        lastErr = new Error("Unexpected rendezvous reply while requesting relay");
      } catch (e) {
        lastErr = e;
      } finally {
        rs.close();
      }
    }
    throw lastErr ?? new Error("Failed to request relay");
  }

  // Port of client.rs secure_connection (relay branch: never bail, fall back to
  // an unencrypted stream when identity cannot be verified).
  private async secureConnection(conn: WsStream, signedIdPk: Uint8Array): Promise<void> {
    let signPk: Uint8Array | null = null;
    if (signedIdPk.length > 0) {
      const rsPk = safeDecodeBase64(serverKey() || RS_PUB_KEY);
      if (rsPk) {
        const opened = signOpen(signedIdPk, rsPk);
        if (opened) {
          try {
            const idpk = fromBinary(IdPkSchema, opened);
            if (idpk.id === this.id && idpk.pk.length === 32) signPk = idpk.pk;
          } catch {
            /* fallthrough */
          }
        }
      }
      if (!signPk) log.error("Handshake failed: invalid public key from rendezvous server");
    }
    this.peerSignPk = signPk;
    if (!signPk) {
      // "send an empty message out in case server is setting up secure"
      conn.send(toBinary(MessageSchema, create(MessageSchema, {})));
      this.secured = false;
      return;
    }
    const raw = await conn.next(READ_TIMEOUT);
    let msg: Message;
    try {
      msg = fromBinary(MessageSchema, raw);
    } catch {
      log.error("Handshake failed: invalid message format");
      conn.send(toBinary(MessageSchema, create(MessageSchema, {})));
      this.secured = false;
      return;
    }
    if (msg.union.case !== "signedId") {
      log.error("Handshake failed: invalid message type");
      conn.send(toBinary(MessageSchema, create(MessageSchema, {})));
      this.secured = false;
      return;
    }
    const opened = signOpen(msg.union.value.id, signPk);
    if (!opened) {
      log.info("pk mismatch, fall back to non-secure");
      const m = create(MessageSchema, {});
      m.union = { case: "publicKey", value: create(PublicKeySchema, {}) };
      conn.send(toBinary(MessageSchema, m));
      this.secured = false;
      return;
    }
    let theirPk: Uint8Array | null = null;
    try {
      const idpk = fromBinary(IdPkSchema, opened);
      if (idpk.id === this.id) theirPk = idpk.pk;
    } catch {
      /* fallthrough */
    }
    if (!theirPk || theirPk.length !== 32) {
      log.error("Handshake failed: sign failure");
      conn.send(toBinary(MessageSchema, create(MessageSchema, {})));
      this.secured = false;
      return;
    }
    const { asymmetricValue, symmetricValue, key } = createSymmetricKeyMsg(theirPk);
    const m = create(MessageSchema, {});
    m.union = { case: "publicKey", value: create(PublicKeySchema, { asymmetricValue, symmetricValue }) };
    conn.send(toBinary(MessageSchema, m));
    conn.setKey(key);
    this.secured = true;
    log.info("secured");
  }

  private confirmInsecure(): Promise<boolean> {
    this.msgbox("insecure-connection-nocancel-hasclose", "Insecure Connection", "conn-e2ee-unavailable-tip");
    return new Promise((resolve) => {
      this.insecureDecision = resolve;
    });
  }

  continueInsecure(ok: boolean): void {
    const d = this.insecureDecision;
    this.insecureDecision = null;
    d?.(ok);
  }

  // ---- message loop --------------------------------------------------------

  private async msgLoop(conn: WsStream): Promise<void> {
    for (;;) {
      if (this.isClosed()) return;
      let raw: Uint8Array;
      try {
        raw = await conn.next(PEER_IDLE_TIMEOUT);
      } catch (e) {
        if (this.isClosed()) return;
        if (e instanceof WsTimeoutError) throw new Error("Timeout");
        throw e;
      }
      if (raw.length === 0) continue;
      let msg: Message;
      try {
        msg = fromBinary(MessageSchema, raw);
      } catch (e) {
        log.warn("bad message from peer", e);
        continue;
      }
      if (!(await this.handlePeerMessage(msg))) return;
    }
  }

  private async handlePeerMessage(msg: Message): Promise<boolean> {
    const u = msg.union;
    switch (u.case) {
      case "videoFrame":
        if (!this.isFileTransfer) this.video.handle(u.value);
        return true;
      case "hash":
        this.handleHash(u.value);
        return true;
      case "loginResponse": {
        const lr = u.value;
        this.enableTrustedDevices = lr.enableTrustedDevices;
        if (lr.union.case === "error") this.handleLoginError(lr.union.value);
        else if (lr.union.case === "peerInfo") this.handlePeerInfo(lr.union.value);
        return true;
      }
      case "peerInfo":
        this.displays = u.value.displays;
        this.host.emit("sync_peer_info", { displays: displaysJson(u.value.displays) });
        if (u.value.platformAdditions) {
          this.host.emit("sync_platform_additions", { platform_additions: u.value.platformAdditions });
        }
        return true;
      case "cursorData": {
        const cd = u.value;
        let colors: Uint8Array;
        try {
          colors = zstdDecompress(cd.colors);
        } catch (e) {
          log.warn("cursor zstd decode failed", e);
          return true;
        }
        this.host.emit("cursor_data", {
          id: cd.id.toString(),
          hotx: String(cd.hotx),
          hoty: String(cd.hoty),
          width: String(cd.width),
          height: String(cd.height),
          colors: jsonStr(Array.from(colors)),
        });
        return true;
      }
      case "cursorId":
        this.host.emit("cursor_id", { id: u.value.toString() });
        return true;
      case "cursorPosition":
        this.host.emit("cursor_position", { x: String(u.value.x), y: String(u.value.y) });
        return true;
      case "testDelay":
        this.handleTestDelay(u.value);
        return true;
      case "misc":
        return this.handleMisc(u.value);
      case "messageBox": {
        const mb = u.value;
        // io_loop.rs only forwards links from its allowlist; drop them here.
        this.msgbox(mb.msgtype, mb.title, mb.text, "");
        return true;
      }
      case "fileAction":
        this.fileTransfer.handleAction(u.value);
        return true;
      case "fileResponse":
        this.fileTransfer.handleResponse(u.value);
        return true;
      case "clipboard":
        this.handleClipboards([u.value]);
        return true;
      case "multiClipboards":
        this.handleClipboards(u.value.clipboards);
        return true;
      case "audioFrame":
      case "cliprdr":
      case "voiceCallRequest":
      case "voiceCallResponse":
        // phase 2
        return true;
      default:
        return true;
    }
  }

  private handleMisc(misc: Misc): boolean {
    const u = misc.union;
    switch (u.case) {
      case "permissionInfo": {
        const name = permissionName(u.value.permission);
        if (name === "clipboard") this.serverClipboardEnabled = u.value.enabled;
        if (name === "keyboard") this.serverKeyboardEnabled = u.value.enabled;
        if (name) this.host.emit("permission", { [name]: u.value.enabled ? "true" : "false" });
        // io_loop.rs: a file-transfer session ends when the File permission is revoked
        if (name === "file" && !u.value.enabled && this.isFileTransfer) {
          this.msgbox("error", "Connection Error", "File transfer permission was revoked");
          this.close(false);
          return false;
        }
        return true;
      }
      case "switchDisplay":
        this.handleSwitchDisplay(u.value);
        return true;
      case "closeReason":
        this.msgbox("error", "Connection Error", u.value);
        this.close(false);
        return false;
      case "uac":
        if (u.value) this.msgbox("on-uac", "Prompt", "Please wait for confirmation of UAC...");
        else {
          this.cancelMsgbox("on-uac");
          this.cancelMsgbox("wait-uac");
          this.cancelMsgbox("elevation-error");
        }
        return true;
      case "foregroundWindowElevated":
        if (u.value) this.msgbox("on-foreground-elevated", "Prompt", "elevated_foreground_window_tip");
        else {
          this.cancelMsgbox("on-foreground-elevated");
          this.cancelMsgbox("wait-uac");
          this.cancelMsgbox("elevation-error");
        }
        return true;
      case "elevationResponse":
        if (u.value === "") this.msgbox("wait-uac", "", "");
        else {
          this.cancelMsgbox("wait-uac");
          this.msgbox("elevation-error", "Elevation Error", u.value);
        }
        return true;
      case "portableServiceRunning":
        this.host.emit("portable_service_running", { running: u.value ? "true" : "false" });
        return true;
      case "supportedEncoding":
        return true;
      case "followCurrentDisplay":
        this.host.emit("follow_current_display", { display_idx: String(u.value) });
        return true;
      case "chatMessage":
        this.host.emit("chat_client_mode", { text: u.value.text });
        return true;
      case "audioFormat":
        return true; // phase 2
      default:
        return true;
    }
  }

  private cancelMsgbox(tag: string): void {
    this.host.emit("cancel_msgbox", { tag });
  }

  private handleTestDelay(t: TestDelay): void {
    if (t.fromClient) return;
    this.lastDelay = t.lastDelay;
    this.targetBitrate = t.targetBitrate;
    // Echo back unchanged; the peer measures RTT and sends last_delay next time.
    const m = create(MessageSchema, {});
    m.union = { case: "testDelay", value: t };
    this.sendMessage(m);
  }

  private handleSwitchDisplay(s: SwitchDisplay): void {
    this.currentDisplay = s.display;
    const d = this.displays[s.display];
    if (d) {
      d.x = s.x;
      d.y = s.y;
      d.width = s.width;
      d.height = s.height;
      d.cursorEmbedded = s.cursorEmbedded;
    }
    this.video.reset(s.display);
    this.host.emit("switch_display", {
      display: String(s.display),
      x: String(s.x),
      y: String(s.y),
      width: String(s.width),
      height: String(s.height),
      cursor_embedded: s.cursorEmbedded ? "1" : "0",
      resolutions: resolutionsJson(s.resolutions?.resolutions ?? []),
      original_width: String(s.originalResolution?.width ?? 0),
      original_height: String(s.originalResolution?.height ?? 0),
    });
  }

  // ---- login ---------------------------------------------------------------

  private handleHash(hash: Hash): void {
    this.hash = hash;
    this.state = "logging-in";
    let p1: Uint8Array | null = null;
    if (this.rawPassword) {
      p1 = sha256(this.rawPassword, hash.salt);
    } else {
      p1 = this.peer.getHashedPassword() ?? this.host.siblingHashedPassword?.() ?? null;
    }
    this.hashedPassword = p1;
    let p2: Uint8Array = new Uint8Array();
    if (p1) {
      p2 = sha256(p1, hash.challenge);
    } else {
      // login without password, the remote side can click accept
      this.msgbox("input-password", "Password Required", "");
    }
    this.sendLogin(p2);
  }

  login(password: string, remember: boolean): void {
    if (!this.hash) {
      log.warn("login before hash");
      return;
    }
    let p1: Uint8Array | null;
    if (password) {
      p1 = sha256(password, this.hash.salt);
      this.remember = remember;
    } else {
      p1 = this.hashedPassword ?? this.peer.getHashedPassword();
    }
    this.hashedPassword = p1;
    const p2 = p1 ? sha256(p1, this.hash.challenge) : new Uint8Array();
    this.sendLogin(p2);
  }

  send2fa(code: string, trustThisDevice: boolean): void {
    const m = create(MessageSchema, {});
    m.union = {
      case: "auth2fa",
      value: create(Auth2FASchema, {
        code,
        hwid: trustThisDevice ? sha256(localOptions.get("uuid") || "web") : new Uint8Array(),
      }),
    };
    if (trustThisDevice) this.peer.setOption("trust-this-device", "Y");
    this.sendMessage(m);
  }

  private sendLogin(password: Uint8Array): void {
    const lr = create(LoginRequestSchema, {
      username: this.id,
      password,
      myId: myId(),
      myName: myName(),
      myPlatform: localOs(),
      // client.rs get_option_message: no OptionMessage for file transfer
      option: this.isFileTransfer ? undefined : this.optionMessage(true),
      sessionId: this.sessionId,
      version: VERSION,
      hwid: this.peer.getOption("trust-this-device") === "Y" ? sha256(localOptions.get("uuid") || "web") : new Uint8Array(),
    });
    if (this.isFileTransfer) {
      lr.union = {
        case: "fileTransfer",
        value: create(FileTransferSchema, {
          dir: this.peer.getOption("remote_dir"),
          showHidden: this.peer.getOption("remote_show_hidden") !== "",
        }),
      };
    }
    const m = create(MessageSchema, {});
    m.union = { case: "loginRequest", value: lr };
    this.sendMessage(m);
  }

  private handleLoginError(err: string): void {
    if (err === LOGIN_MSG_PASSWORD_EMPTY) {
      this.hashedPassword = null;
      this.msgbox("input-password", "Password Required", "");
    } else if (err === LOGIN_MSG_PASSWORD_WRONG) {
      this.hashedPassword = null;
      this.msgbox("re-input-password", err, "Do you want to enter again?");
    } else if (err === LOGIN_MSG_2FA_WRONG || err === REQUIRE_2FA) {
      if (this.peer.getOption("trust-this-device") === "Y") this.peer.setOption("trust-this-device", "");
      this.msgbox("input-2fa", err, "");
    } else {
      this.msgbox("error", "Login Error", err);
    }
  }

  private handlePeerInfo(pi: PeerInfo): void {
    this.peerInfo = pi;
    this.displays = pi.displays;
    this.state = "connected";
    this.rawPassword = "";
    if (this.isFileTransfer) {
      this.peer.setInfo({
        id: this.id,
        username: pi.username,
        hostname: pi.hostname,
        platform: pi.platform,
        alias: this.peer.getOption("alias"),
        tags: [],
        lastConnected: Date.now(),
      });
      if (this.remember && this.hashedPassword) this.peer.setHashedPassword(this.hashedPassword);
      // ui_session_interface.rs handle_peer_info: close_success for file transfer
      this.msgbox("success", "Successful", "");
      this.host.emit("peer_info", {
        username: pi.username,
        hostname: pi.hostname,
        platform: pi.platform,
        sas_enabled: pi.sasEnabled ? "true" : "false",
        displays: "[]",
        version: pi.version,
        features: jsonStr({ privacy_mode: false }),
        current_display: "0",
        resolutions: "[]",
        platform_additions: pi.platformAdditions,
      });
      return;
    }
    if (pi.displays.length === 0) {
      this.msgbox("error", "Remote Error", "No Display");
      return;
    }
    if (pi.currentDisplay >= 0 && pi.currentDisplay < pi.displays.length) {
      this.currentDisplay = pi.currentDisplay;
    } else {
      this.currentDisplay = 0;
    }
    // LoginConfigHandler::handle_peer_info: persist info + remembered password
    this.peer.setInfo({
      id: this.id,
      username: pi.username,
      hostname: pi.hostname,
      platform: pi.platform,
      alias: this.peer.getOption("alias"),
      tags: [],
      lastConnected: Date.now(),
    });
    if (this.remember && this.hashedPassword) this.peer.setHashedPassword(this.hashedPassword);
    else if (!this.remember && this.hashedPassword && !this.peer.getHashedPassword()) {
      /* not remembered: nothing to store */
    }
    log.info("peer_info displays", displaysJson(pi.displays), "current", this.currentDisplay, "peer", pi.platform, pi.version);
    this.msgbox("success", "Successful", "Connected, waiting for image...");
    const features: Record<string, boolean> = { privacy_mode: pi.features?.privacyMode ?? false };
    this.host.emit("peer_info", {
      username: pi.username,
      hostname: pi.hostname,
      platform: pi.platform,
      sas_enabled: pi.sasEnabled ? "true" : "false",
      displays: displaysJson(pi.displays),
      version: pi.version,
      features: jsonStr(features),
      current_display: String(this.currentDisplay),
      resolutions: resolutionsJson(pi.resolutions?.resolutions ?? []),
      platform_additions: pi.platformAdditions,
    });
    this.startQualityTimer();
    this.startClipboard();
  }

  // ---- clipboard -----------------------------------------------------------

  // ui_session_interface.rs is_text_clipboard_required
  private isTextClipboardRequired(): boolean {
    return (
      this.serverClipboardEnabled &&
      this.serverKeyboardEnabled &&
      !this.peer.getToggle("disable-clipboard") &&
      !this.peer.getToggle("view-only")
    );
  }

  private startClipboard(): void {
    if (this.clipboardWatcher) return;
    this.clipboardWatcher = new ClipboardWatcher({
      isRequired: () => this.state === "connected" && this.isTextClipboardRequired(),
      send: (text) => this.sendMessage(buildClipboardMessage(text, this.peerVersion, this.peerPlatform)),
    });
    this.clipboardWatcher.start();
    void this.clipboardWatcher.syncNow();
  }

  private handleClipboards(cbs: { format: number; compress: boolean; content: Uint8Array }[]): void {
    // io_loop.rs gate: disable_clipboard / view_only drop inbound too
    if (this.peer.getToggle("disable-clipboard") || this.peer.getToggle("view-only")) return;
    const text = textFromClipboards(cbs as never);
    if (text === null) return;
    this.clipboardWatcher?.noteRemoteText(text);
    this.host.emit("clipboard", { content: text });
  }

  // ---- outgoing ------------------------------------------------------------

  private sendMessage(m: Message): void {
    if (!this.ws || this.state === "closed") return;
    try {
      this.ws.send(toBinary(MessageSchema, m));
    } catch (e) {
      log.warn("send failed", e);
    }
  }

  private sendMisc(misc: Misc): void {
    const m = create(MessageSchema, {});
    m.union = { case: "misc", value: misc };
    this.sendMessage(m);
  }

  sendMouse(json: MouseJson): void {
    if (this.state !== "connected") return;
    const evt = buildMouseEvent(json, { swapLeftRight: this.peer.getToggle("swap-left-right-mouse") });
    if (!evt) return;
    this.sendMouseEvent(evt);
  }

  private sendMouseEvent(evt: PbMouseEvent): void {
    const m = create(MessageSchema, {});
    m.union = { case: "mouseEvent", value: evt };
    this.sendMessage(m);
  }

  private sendKeyEvent(evt: KeyEvent | null): void {
    if (!evt || this.state !== "connected") return;
    const m = create(MessageSchema, {});
    m.union = { case: "keyEvent", value: evt };
    this.sendMessage(m);
  }

  inputKey(name: string, flags: KeyFlags): void {
    const evt = buildLegacyKeyEvent(name, flags);
    if (!evt) log.warn(`input_key: no mapping for "${name}"`);
    this.sendKeyEvent(evt);
  }

  // Dart map mode: sessionHandleFlutterKeyEvent {name: character, usb_hid, lock_modes, down}
  flutterKeyEvent(name: string, usbHid: number, lockModes: number, down: boolean): void {
    if (name === "flutter_key") {
      this.sendKeyEvent(buildFlutterSimulationKey(usbHid, down));
      return;
    }
    const evt = buildMapKeyEvent(usbHid, down, lockModes, this.peerPlatform);
    if (!evt) {
      log.warn(`flutter_key_event: no mapping for usb_hid 0x${usbHid.toString(16)} on peer "${this.peerPlatform}"`);
      return;
    }
    this.sendKeyEvent(evt);
  }

  inputString(seq: string): void {
    this.sendKeyEvent(buildInputString(seq));
  }

  ctrlAltDel(): void {
    this.sendKeyEvent(buildCtrlAltDel(this.peerPlatform));
  }

  lockScreen(): void {
    this.sendKeyEvent(buildLockScreen());
  }

  refresh(): void {
    this.requestKeyframe(this.currentDisplay, true);
  }

  private requestKeyframe(display: number, force = false): void {
    const now = Date.now();
    const last = this.lastKeyframeRequest.get(display) ?? 0;
    if (!force && now - last < 1000) return;
    this.lastKeyframeRequest.set(display, now);
    const misc = create(MiscSchema, {});
    if (isSupportMultiUiSession(this.peerVersion)) misc.union = { case: "refreshVideoDisplay", value: display };
    else misc.union = { case: "refreshVideo", value: true };
    this.sendMisc(misc);
  }

  switchDisplay(display: number): void {
    const misc = create(MiscSchema, {});
    misc.union = { case: "switchDisplay", value: create(SwitchDisplaySchema, { display, width: 0, height: 0 }) };
    this.sendMisc(misc);
    const cap = create(MiscSchema, {});
    cap.union = { case: "captureDisplays", value: create(CaptureDisplaysSchema, { set: [display] }) };
    this.sendMisc(cap);
  }

  // ui_session_interface.rs send_chat
  sendChat(text: string): void {
    if (this.state !== "connected" || !text) return;
    const misc = create(MiscSchema, {});
    misc.union = { case: "chatMessage", value: create(ChatMessageSchema, { text }) };
    this.sendMisc(misc);
  }

  sendOption(option: OptionMessage): void {
    const misc = create(MiscSchema, {});
    misc.union = { case: "option", value: option };
    this.sendMisc(misc);
  }

  // Port of LoginConfigHandler::get_option_message (DEFAULT_CONN branch).
  optionMessage(ignoreDefault: boolean): OptionMessage {
    const yes = OptionMessage_BoolOption.Yes;
    const msg = create(OptionMessageSchema, {});
    const q = this.peer.getSessionOption("image_quality");
    const iq = imageQualityEnum(q, ignoreDefault);
    if (iq !== null) msg.imageQuality = iq;
    else if (q === "custom") {
      const quality = parseInt(this.peer.getSessionOption("custom_image_quality"), 10) || 50;
      msg.customImageQuality = quality << 8;
      const fps = parseInt(this.peer.getSessionOption("custom-fps"), 10) || 30;
      msg.customFps = fps;
    }
    const viewOnly = this.peer.getToggle("view-only");
    if (viewOnly) msg.disableKeyboard = yes;
    if (viewOnly || this.peer.getToggle("show-remote-cursor")) msg.showRemoteCursor = yes;
    if (viewOnly && this.peer.getToggle("show-my-cursor")) msg.showMyCursor = yes;
    if (this.peer.getToggle("follow-remote-cursor")) msg.followRemoteCursor = yes;
    if (this.peer.getToggle("follow-remote-window")) msg.followRemoteWindow = yes;
    if (!viewOnly && this.peer.getToggle("lock-after-session-end")) msg.lockAfterSessionEnd = yes;
    // No audio pipeline in the browser yet.
    msg.disableAudio = yes;
    if (viewOnly || this.peer.getToggle("disable-clipboard")) msg.disableClipboard = yes;
    msg.supportedDecoding = this.supportedDecoding();
    return msg;
  }

  supportedDecoding(): SupportedDecoding {
    return buildSupportedDecoding(this.abilities, this.unsupported, this.peer.getSessionOption("codec-preference"));
  }

  updateSupportedDecoding(): void {
    const opt = create(OptionMessageSchema, { supportedDecoding: this.supportedDecoding() });
    this.sendOption(opt);
  }

  alternativeCodecs(): string {
    return jsonStr({
      vp8: this.abilities.vp8 && !this.unsupported.has("vp8"),
      av1: this.abilities.av1 && !this.unsupported.has("av1"),
      h264: this.abilities.h264 && !this.unsupported.has("h264"),
      h265: this.abilities.h265 && !this.unsupported.has("h265"),
    });
  }

  private onDecoderError(display: number, codec: CodecName, err: unknown): void {
    log.error(`marking ${codec} unsupported after decoder error`, err);
    this.codecFormat = "";
    if (!this.unsupported.has(codec)) {
      this.unsupported.add(codec);
      this.updateSupportedDecoding();
    }
    this.requestKeyframe(display, true);
  }

  // ---- quality monitor -----------------------------------------------------

  private startQualityTimer(): void {
    this.stopQualityTimer();
    this.qualityTimer = setInterval(() => {
      const fps = this.video.takeFps();
      this.host.emit("update_quality_status", {
        speed: "",
        fps: jsonStr(fps),
        delay: String(this.lastDelay),
        target_bitrate: String(this.targetBitrate),
        codec_format: this.codecFormat,
        chroma: "I420",
      });
    }, 1000) as unknown as number;
  }

  private stopQualityTimer(): void {
    if (this.qualityTimer !== null) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function punchFailureText(phr: PunchHoleResponse): string {
  if (phr.otherFailure) return phr.otherFailure;
  switch (phr.failure) {
    case PunchHoleResponse_Failure.ID_NOT_EXIST:
      return "ID does not exist";
    case PunchHoleResponse_Failure.OFFLINE:
      return "Remote desktop is offline";
    case PunchHoleResponse_Failure.LICENSE_MISMATCH:
      return "Key mismatch";
    case PunchHoleResponse_Failure.LICENSE_OVERUSE:
      return "Key overuse";
    default:
      return "other punch hole failure";
  }
}

function safeDecodeBase64(v: string): Uint8Array | null {
  try {
    const b = decodeBase64(v);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

function permissionName(p: PermissionInfo_Permission): string | null {
  switch (p) {
    case PermissionInfo_Permission.Keyboard:
      return "keyboard";
    case PermissionInfo_Permission.Clipboard:
      return "clipboard";
    case PermissionInfo_Permission.Audio:
      return "audio";
    case PermissionInfo_Permission.File:
      return "file";
    case PermissionInfo_Permission.Restart:
      return "restart";
    case PermissionInfo_Permission.Recording:
      return "recording";
    case PermissionInfo_Permission.BlockInput:
      return "block_input";
    case PermissionInfo_Permission.PrivacyMode:
      return "privacy_mode";
    default:
      return null;
  }
}

// flutter.rs make_displays_msg
export function displaysJson(displays: DisplayInfo[]): string {
  return jsonStr(
    displays.map((d) => {
      const h: Record<string, number> = {
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
        cursor_embedded: d.cursorEmbedded ? 1 : 0,
      };
      if (d.originalResolution) {
        h["original_width"] = d.originalResolution.width;
        h["original_height"] = d.originalResolution.height;
      }
      if (d.scale > 0) h["scaled_width"] = Math.round(d.width / d.scale);
      return h;
    })
  );
}

function resolutionsJson(rs: { width: number; height: number }[]): string {
  return jsonStr(rs.map((r) => ({ width: r.width, height: r.height })));
}

export function imageQualityEnum(q: string, ignoreDefault: boolean): ImageQuality | null {
  switch (q) {
    case "low":
      return ImageQuality.Low;
    case "best":
      return ImageQuality.Best;
    case "balanced":
      return ignoreDefault ? null : ImageQuality.Balanced;
    default:
      return null;
  }
}

function randomU64(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

// Port of client.rs check_if_retry (retry_for_relay = false).
export function checkIfRetry(msgtype: string, title: string, text: string): boolean {
  if (msgtype !== "error" || title !== "Connection Error") return false;
  const t = text.toLowerCase();
  return !t.includes("offline") && !t.includes("not exist") && !t.includes("handshake");
}

export { u8 };
