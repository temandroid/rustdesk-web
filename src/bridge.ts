// window.setByName / window.getByName dispatch for flutter/lib/web/bridge.dart,
// plus the two event channels Dart installs (onGlobalEvent for session events,
// onRegisteredEvent for global ones).
import { create } from "@bufbuild/protobuf";
import { OptionMessageSchema, OptionMessage_BoolOption } from "./proto/message_pb";
import { Session, imageQualityEnum, type Fields } from "./session";
import { ConnType } from "./proto/rendezvous_pb";
import { sessions, type SessionSlot } from "./sessions";
import {
  PeerStore,
  envVars,
  flutterLocalOptions,
  globalOptions,
  localOptions,
  localOs,
  myId,
  myName,
  myUuid,
  userDefaultOptions,
} from "./config";
import { VERSION, getVersionNumber } from "./version";
import { probeCodecs } from "./video/webcodecs";
import { queryOnlines } from "./rendezvous";
import { LANGS, translate } from "./lang";
import { audioSupported } from "./audio";
import { log } from "./log";

type Json = Record<string, unknown>;

interface WindowGlobals {
  onGlobalEvent?: (json: string) => void;
  onRegisteredEvent?: (json: string) => void;
  onVideoFrame?: ((display: number, frame: VideoFrame) => void) | null;
  onRgba?: ((display: number, rgba: Uint8Array) => void) | null;
  onInitFinished?: () => void;
  closeConnection?: () => void;
}

const win = globalThis as unknown as WindowGlobals;

export function emitSessionEvent(name: string, fields: Fields): void {
  const slot = sessions.top();
  if (slot) {
    sessions.emit(slot, name, fields);
    return;
  }
  const fn = win.onGlobalEvent;
  if (typeof fn !== "function") return;
  try {
    fn(JSON.stringify({ ...fields, name }));
  } catch (e) {
    log.error("onGlobalEvent threw", e);
  }
}

export function emitGlobalEvent(name: string, fields: Fields): void {
  const fn = win.onRegisteredEvent;
  if (typeof fn !== "function") return;
  try {
    fn(JSON.stringify({ ...fields, name }));
  } catch (e) {
    log.error("onRegisteredEvent threw", e);
  }
}

// localStorage "rd:debug-keys" = "1" logs every key call from Dart.
function keyDebug(): boolean {
  try {
    return globalThis.localStorage?.getItem("rd:debug-keys") === "1";
  } catch {
    return false;
  }
}

// Session routing. The web shell passes no session ids, so calls are routed
// by kind: view/input -> the remote (DEFAULT_CONN) session, file calls -> the
// file-transfer session, everything else -> the session whose page is on top.
function top(): Session | null {
  return sessions.top()?.session ?? null;
}
function def(): Session | null {
  return sessions.byType(ConnType.DEFAULT_CONN)?.session ?? null;
}
function ft(): Session | null {
  return sessions.byType(ConnType.FILE_TRANSFER)?.session ?? null;
}
function peerIdForOptions(): string {
  return (sessions.byType(ConnType.DEFAULT_CONN) ?? sessions.top())?.peerId ?? "";
}

function parseJson(arg: unknown): Json {
  if (typeof arg !== "string") return {};
  try {
    const v = JSON.parse(arg);
    return v && typeof v === "object" ? (v as Json) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function flag(v: unknown): boolean {
  return v === true || v === "true";
}

function sessionAddSync(arg: unknown): string {
  const a = parseJson(arg);
  const id = str(a["id"]).trim();
  if (!id) return "Invalid ID";
  if (flag(a["isViewCamera"]) || flag(a["isTerminal"])) {
    return "Camera and terminal sessions are not supported in this web client build";
  }
  const connType = flag(a["isFileTransfer"]) ? ConnType.FILE_TRANSFER : ConnType.DEFAULT_CONN;
  // One session per kind: a new remote or file session replaces its predecessor.
  const prev = sessions.byType(connType);
  if (prev) {
    prev.session.close();
    sessions.remove(prev);
  }
  const slot: SessionSlot = sessions.add(connType, id);
  slot.session = new Session(
    { id, password: str(a["password"]), isSharedPassword: flag(a["is_shared_password"]), connType },
    {
      emit: (name, fields) => sessions.emit(slot, name, fields),
      onVideoFrame: (display, frame) => sessions.videoFrame(slot, display, frame),
      onRgba: (display, rgba) => sessions.rgba(slot, display, rgba),
      onClosed: () => sessions.remove(slot),
      siblingHashedPassword: () => {
        for (const other of sessions.all()) {
          if (other !== slot && other.peerId === id && other.session.currentHashedPassword) {
            return other.session.currentHashedPassword;
          }
        }
        return null;
      },
    }
  );
  return "";
}

function peerStoreFor(id?: string): PeerStore {
  return new PeerStore(id && id !== "" ? id : peerIdForOptions());
}

function sendToggleOption(name: string, on: boolean): void {
  const current = def();
  if (!current) return;
  const v = on ? OptionMessage_BoolOption.Yes : OptionMessage_BoolOption.No;
  const opt = create(OptionMessageSchema, {});
  switch (name) {
    case "show-remote-cursor":
      opt.showRemoteCursor = v;
      break;
    case "follow-remote-cursor":
      opt.followRemoteCursor = v;
      break;
    case "follow-remote-window":
      opt.followRemoteWindow = v;
      break;
    case "lock-after-session-end":
      opt.lockAfterSessionEnd = v;
      break;
    case "privacy-mode":
      opt.privacyMode = v;
      break;
    case "view-only":
      opt.disableKeyboard = v;
      break;
    case "show-my-cursor":
      opt.showMyCursor = v;
      break;
    case "disable-clipboard":
      opt.disableClipboard = v;
      break;
    case "disable-audio":
      opt.disableAudio = audioSupported() ? v : OptionMessage_BoolOption.Yes;
      current.setAudioMuted(on);
      break;
    default:
      return;
  }
  current.sendOption(opt);
}

export function setByName(name: string, arg: unknown): string {
  try {
    return setByNameImpl(name, arg);
  } catch (e) {
    log.error(`setByName(${name}) failed`, e);
    return "";
  }
}

function setByNameImpl(name: string, arg: unknown): string {
  switch (name) {
    case "session_add_sync":
      return sessionAddSync(arg);
    case "session_start": {
      const a = parseJson(arg);
      const id = str(a["id"]);
      // the most recently added, not yet started session for this peer
      const slot = [...sessions.all()].reverse().find((x) => x.peerId === id && !x.session.hasStarted) ?? sessions.top();
      slot?.session.start();
      return "";
    }
    case "login": {
      const a = parseJson(arg);
      top()?.login(str(a["password"]), flag(a["remember"]));
      return "";
    }
    case "send_2fa": {
      const a = parseJson(arg);
      top()?.send2fa(str(a["code"]), flag(a["trust_this_device"]));
      return "";
    }
    case "session_close": {
      const slot = sessions.top();
      if (slot) {
        slot.session.close();
        sessions.remove(slot);
      }
      return "";
    }
    case "reconnect": {
      const slot = sessions.top();
      if (!slot) return "";
      const isFt = slot.connType === ConnType.FILE_TRANSFER;
      slot.session.close();
      sessions.remove(slot);
      sessionAddSync(JSON.stringify({ id: slot.peerId, password: "", isFileTransfer: isFt }));
      top()?.start();
      return "";
    }
    case "refresh":
      def()?.refresh();
      return "";
    case "switch_display": {
      const a = parseJson(arg);
      const v = a["value"];
      const idx = Array.isArray(v) ? Number(v[0]) : Number(v);
      if (Number.isFinite(idx)) def()?.switchDisplay(idx);
      return "";
    }
    case "send_mouse":
      def()?.sendMouse(parseJson(arg) as Record<string, string>);
      return "";
    case "input_key": {
      const a = parseJson(arg);
      if (keyDebug()) log.info("input_key", arg);
      def()?.inputKey(str(a["name"]), {
        down: flag(a["down"]),
        press: flag(a["press"]),
        alt: flag(a["alt"]),
        ctrl: flag(a["ctrl"]),
        shift: flag(a["shift"]),
        command: flag(a["command"]),
      });
      return "";
    }
    case "flutter_key_event": {
      const a = parseJson(arg);
      if (keyDebug()) log.info("flutter_key_event", arg);
      def()?.flutterKeyEvent(str(a["name"]), Number(a["usb_hid"]) || 0, Number(a["lock_modes"]) || 0, flag(a["down"]));
      return "";
    }
    case "input_string":
      def()?.inputString(str(arg));
      return "";
    case "send_chat":
      def()?.sendChat(str(arg));
      return "";
    // ---- file transfer (flutter/lib/web/bridge.dart + web_unique.dart) ----
    case "read_remote_dir": {
      const a = parseJson(arg);
      ft()?.fileTransfer.readRemoteDir(str(a["path"]), flag(a["include_hidden"]));
      return "";
    }
    case "send_files": {
      const a = parseJson(arg);
      const current = ft();
      if (!current) return "";
      if (flag(a["is_remote"])) {
        void current.fileTransfer.startDownload(num(a["id"]), str(a["path"]), flag(a["include_hidden"]), flag(a["is_dir"]));
      } else {
        log.warn("send_files with is_remote=false is not used on web (uploads go through send_local_files)");
      }
      return "";
    }
    case "send_local_files": {
      const a = parseJson(arg);
      const file = pickedFiles[num(a["handle_index"])];
      const current = ft();
      if (!current || !file) {
        log.warn("send_local_files: unknown handle", arg);
        return "";
      }
      current.fileTransfer.startUpload(num(a["id"]), file, str(a["to"]));
      return "";
    }
    case "select_files":
      selectFiles(arg === true || arg === "true");
      return "";
    case "confirm_override_file": {
      const a = parseJson(arg);
      ft()?.fileTransfer.confirmOverride(num(a["id"]), num(a["file_num"]), flag(a["need_override"]), flag(a["is_upload"]));
      return "";
    }
    case "remove_file": {
      const a = parseJson(arg);
      ft()?.fileTransfer.removeFile(num(a["id"]), str(a["path"]), num(a["file_num"]));
      return "";
    }
    case "read_dir_to_remove_recursive": {
      const a = parseJson(arg);
      ft()?.fileTransfer.readDirToRemoveRecursive(num(a["id"]), str(a["path"]), flag(a["show_hidden"]));
      return "";
    }
    case "remove_all_empty_dirs": {
      const a = parseJson(arg);
      ft()?.fileTransfer.removeAllEmptyDirs(num(a["id"]), str(a["path"]));
      return "";
    }
    case "create_dir": {
      const a = parseJson(arg);
      ft()?.fileTransfer.createDir(num(a["id"]), str(a["path"]));
      return "";
    }
    case "rename_file": {
      const a = parseJson(arg);
      ft()?.fileTransfer.renameFile(num(a["id"]), str(a["path"]), str(a["new_name"]));
      return "";
    }
    case "cancel_job":
      ft()?.fileTransfer.cancelJob(num(arg));
      return "";
    case "ctrl_alt_del":
      def()?.ctrlAltDel();
      return "";
    case "lock_screen":
      def()?.lockScreen();
      return "";
    case "enter_or_leave":
      return "";
    case "option:toggle": {
      const key = str(arg);
      const ps = peerStoreFor();
      const on = !ps.getToggle(key);
      ps.setToggle(key, on);
      sendToggleOption(key, on);
      return "";
    }
    case "option:session": {
      const a = parseJson(arg);
      const k = str(a["name"]);
      const v = str(a["value"]);
      peerStoreFor().setOption(k, v);
      if (k === "codec-preference") def()?.updateSupportedDecoding();
      return "";
    }
    case "change_prefer_codec":
      def()?.updateSupportedDecoding();
      return "";
    case "image_quality": {
      const q = str(arg);
      peerStoreFor().setOption("image_quality", q);
      const iq = imageQualityEnum(q, false);
      const d = def();
      if (iq !== null) d?.sendOption(create(OptionMessageSchema, { imageQuality: iq }));
      else if (q === "custom" && d) d.sendOption(d.optionMessage(false));
      return "";
    }
    case "custom_image_quality": {
      const n = Number(arg);
      if (!Number.isFinite(n)) return "";
      peerStoreFor().setOption("custom_image_quality", String(n));
      def()?.sendOption(create(OptionMessageSchema, { customImageQuality: n << 8 }));
      return "";
    }
    case "custom-fps": {
      const n = Number(arg);
      if (!Number.isFinite(n)) return "";
      peerStoreFor().setOption("custom-fps", String(n));
      def()?.sendOption(create(OptionMessageSchema, { customFps: n }));
      return "";
    }
    case "option": {
      const a = parseJson(arg);
      globalOptions.set(str(a["name"]), str(a["value"]));
      return "";
    }
    case "options": {
      const a = parseJson(arg);
      const d: Record<string, string> = {};
      for (const [k, v] of Object.entries(a)) d[k] = str(v);
      globalOptions.setAll({ ...globalOptions.all(), ...d });
      return "";
    }
    case "option:local": {
      const a = parseJson(arg);
      localOptions.set(str(a["name"]), str(a["value"]));
      return "";
    }
    case "option:flutter:local": {
      const a = parseJson(arg);
      flutterLocalOptions.set(str(a["name"]), str(a["value"]));
      return "";
    }
    case "option:user:default": {
      const a = parseJson(arg);
      userDefaultOptions.set(str(a["name"]), str(a["value"]));
      return "";
    }
    case "option:peer": {
      const a = parseJson(arg);
      peerStoreFor(str(a["id"])).setOption(str(a["name"]), str(a["value"]));
      return "";
    }
    case "option:flutter:peer": {
      const a = parseJson(arg);
      peerStoreFor().setFlutterOption(str(a["name"]), str(a["value"]));
      return "";
    }
    case "envvar": {
      const a = parseJson(arg);
      envVars.set(str(a["name"]), str(a["value"]));
      return "";
    }
    case "fullscreen": {
      // state_model.dart procFullscreenWeb: 'Y' enter, 'N' leave.
      const doc = globalThis.document;
      if (!doc) return "";
      if (str(arg) === "Y") {
        if (!doc.fullscreenElement) void doc.documentElement.requestFullscreen?.().catch((e) => log.warn("requestFullscreen failed", e));
      } else if (doc.fullscreenElement) {
        void doc.exitFullscreen?.().catch((e) => log.warn("exitFullscreen failed", e));
      }
      return "";
    }
    case "common": {
      const a = parseJson(arg);
      if (str(a["name"]) === "continue-insecure-connection") {
        top()?.continueInsecure(str(a["value"]) === "Y");
      }
      return "";
    }
    case "cursor": {
      // custom_cursor.dart: {url, hotx, hoty} or 'auto'
      const doc = globalThis.document;
      if (!doc) return "";
      if (arg === "auto" || arg === "" || arg === undefined) {
        doc.body.style.cursor = "auto";
        return "";
      }
      const a = parseJson(arg);
      const url = str(a["url"]);
      if (url) {
        doc.body.style.cursor = `url(${url}) ${str(a["hotx"]) || 0} ${str(a["hoty"]) || 0}, auto`;
      }
      return "";
    }
    case "remove_peer":
      PeerStore.remove(str(arg));
      return "";
    case "query_onlines": {
      const ids = parseJsonArray(arg);
      void queryOnlines(ids).then(
        (r) => emitGlobalEvent("callback_query_onlines", { onlines: r.onlines.join(","), offlines: r.offlines.join(",") }),
        (e) => log.warn("query_onlines failed", e)
      );
      return "";
    }
    case "fav":
    case "save_ab":
    case "clear_ab":
    case "load_ab":
    case "save_group":
    case "clear_group":
    case "load_group":
    case "send_note":
    case "audit_guid":
    case "selected_sid":
    case "toggle_virtual_display":
    case "toggle_privacy_mode":
    case "change_resolution":
    case "restart":
    case "elevate_direct":
    case "elevate_with_logon":
    case "input_os_password":
    case "account_auth":
    case "account_auth_cancel":
    case "open_terminal":
    case "send_terminal_input":
    case "resize_terminal":
    case "close_terminal":
      log.debug(`setByName ${name} not implemented (phase 2)`);
      return "";
    default:
      log.debug(`setByName ${name} ignored`, arg);
      return "";
  }
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  return Number.isFinite(n) ? n : 0;
}

// Browser files chosen for upload, addressed by index from Dart
// (`selected_files` event -> `send_local_files` with handle_index).
const pickedFiles: File[] = [];
let pickBatch = 0;

function selectFiles(isFolder: boolean): void {
  const doc = globalThis.document;
  if (!doc) return;
  const input = doc.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (isFolder) input.setAttribute("webkitdirectory", "");
  input.style.display = "none";
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    input.remove();
    if (files.length === 0) return;
    const batchId = ++pickBatch;
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const idx = pickedFiles.push(f) - 1;
      emitSessionEvent("selected_files", {
        handleIndex: String(idx),
        file: JSON.stringify({
          entry_type: 4,
          name: rel,
          size: f.size,
          modified_time: Math.max(0, Math.floor(f.lastModified / 1000)),
        }),
        batchId: String(batchId),
      });
    }
  };
  doc.body.appendChild(input);
  input.click();
}

function parseJsonArray(arg: unknown): string[] {
  if (Array.isArray(arg)) return arg.map(str);
  try {
    const v = JSON.parse(str(arg));
    return Array.isArray(v) ? v.map(str) : [];
  } catch {
    return [];
  }
}

let codecProbeJson = JSON.stringify({ vp8: true, av1: false, h264: false, h265: false });
export function setCodecProbeJson(v: string): void {
  codecProbeJson = v;
}

export function getByName(name: string, arg: unknown): string {
  try {
    const v = getByNameImpl(name, arg);
    if (typeof v === "string") return v;
    if (v === undefined || v === null) return "";
    return JSON.stringify(v);
  } catch (e) {
    log.error(`getByName(${name}) failed`, e);
    return "";
  }
}

function recentPeersJson(): string {
  return JSON.stringify(
    PeerStore.recent().map((p) => ({
      id: p.id,
      username: p.username,
      hostname: p.hostname,
      platform: p.platform,
      alias: p.alias,
      hash: "",
    }))
  );
}

function getByNameImpl(name: string, arg: unknown): unknown {
  switch (name) {
    case "version":
      return VERSION;
    case "fullscreen":
      return globalThis.document?.fullscreenElement ? "Y" : "N";
    case "app-name":
      return "RustDesk";
    case "build_date":
      return "web";
    case "local_os":
      return localOs();
    case "my_id":
      return myId();
    case "uuid":
      return myUuid();
    case "my_name":
      return myName();
    case "get_version_number":
      return String(getVersionNumber(str(arg)));
    case "option":
      return globalOptions.get(str(arg));
    case "options":
      return JSON.stringify(globalOptions.all());
    case "option:local": {
      const k = str(arg);
      const v = localOptions.get(k);
      if (k === "input-source" && v === "") return "Input source 2";
      return v;
    }
    case "option:flutter:local":
      return flutterLocalOptions.get(str(arg));
    case "option:user:default":
      return userDefaultOptions.get(str(arg));
    case "option:peer": {
      const a = parseJson(arg);
      return peerStoreFor(str(a["id"])).getOption(str(a["name"]));
    }
    case "option:flutter:peer":
      return peerStoreFor().getFlutterOption(str(arg));
    case "option:session":
      return peerStoreFor().getSessionOption(str(arg));
    case "option:toggle":
      return peerStoreFor().getToggle(str(arg)) ? "true" : "false";
    case "image_quality":
      return peerStoreFor().getSessionOption("image_quality");
    case "remember":
      return top()?.hasRememberedPassword ? "true" : "false";
    case "platform":
      return top()?.peerPlatform ?? "";
    case "alternative_codecs": {
      const d = def();
      return d ? d.alternativeCodecs() : codecProbeJson;
    }
    case "peer_has_password":
      return new PeerStore(str(arg)).getHashedPassword() ? "true" : "false";
    case "peer_exists":
      return PeerStore.exists(str(arg)) ? "true" : "false";
    case "load_recent_peers":
      emitGlobalEvent("load_recent_peers", { peers: recentPeersJson() });
      return "";
    case "load_recent_peers_sync":
      return JSON.stringify({ peers: recentPeersJson() });
    case "load_fav_peers":
      emitGlobalEvent("load_fav_peers", { peers: "[]" });
      return "";
    case "fav":
      return "[]";
    case "langs":
      return JSON.stringify(LANGS);
    case "translate": {
      const a = parseJson(arg);
      return translate(str(a["locale"]), str(a["text"]));
    }
    case "envvar":
      return envVars.get(str(arg));
    case "enable_trusted_devices":
      return top()?.enableTrustedDevices ? "Y" : "";
    case "api_server":
      return globalOptions.get("api-server");
    case "is_using_public_server":
      return globalOptions.get("custom-rendezvous-server") ? "false" : "true";
    case "get_conn_status":
      return JSON.stringify({ status_num: 1 });
    case "main_display":
      return "";
    case "conn_session_id":
    case "last_audit_note":
    case "audit_guid":
    case "audit_server":
    case "account_auth_result":
      return "";
    default:
      log.debug(`getByName ${name} ignored`, arg);
      return "";
  }
}

export async function refreshCodecProbe(): Promise<void> {
  const a = await probeCodecs();
  setCodecProbeJson(JSON.stringify({ vp8: a.vp8, av1: a.av1, h264: a.h264, h265: a.h265 }));
}
