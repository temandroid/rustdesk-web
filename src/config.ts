// localStorage-backed replacement for hbb_common::config (Config, LocalConfig,
// UserDefaultConfig, PeerConfig). Every namespace is one JSON object under a
// prefixed key so a broken entry never takes the others down.
import { log } from "./log";

type Dict = Record<string, string>;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readDict(key: string): Dict {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(key);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Dict) : {};
  } catch {
    return {};
  }
}

function writeDict(key: string, d: Dict): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(d));
  } catch (e) {
    log.warn("localStorage write failed", key, e);
  }
}

class Namespace {
  constructor(private readonly key: string) {}
  get(name: string): string {
    return readDict(this.key)[name] ?? "";
  }
  set(name: string, value: string): void {
    const d = readDict(this.key);
    if (value === "") delete d[name];
    else d[name] = value;
    writeDict(this.key, d);
  }
  all(): Dict {
    return readDict(this.key);
  }
  setAll(d: Dict): void {
    writeDict(this.key, { ...d });
  }
}

// Config::get_option / set_option (server settings, key, api-server ...)
export const globalOptions = new Namespace("rd:options");
// LocalConfig
export const localOptions = new Namespace("rd:local");
// LocalConfig flutter ui options ("option:flutter:local")
export const flutterLocalOptions = new Namespace("rd:flutter-local");
// UserDefaultConfig
export const userDefaultOptions = new Namespace("rd:user-default");
// Config builtin options and env-var style overrides
// mainSetEnv/mainGetEnv: a process environment in the desktop client, so it
// must not outlive the page or leak into other tabs (IS_TERMINAL_ADMIN).
class MemoryVars {
  private readonly vars = new Map<string, string>();
  get(name: string): string {
    return this.vars.get(name) ?? "";
  }
  set(name: string, value: string): void {
    if (value === "") this.vars.delete(name);
    else this.vars.set(name, value);
  }
}
export const envVars = new MemoryVars();
try {
  globalThis.localStorage?.removeItem("rd:envvar");
} catch {
  /* storage unavailable */
}

// Rust UserDefaultConfig defaults (libs/hbb_common config.rs) that the UI
// reads through option:session before a per-peer value exists.
const SESSION_DEFAULTS: Dict = {
  // Rust defaults to "original" (1:1 pixels, scrollable). A browser window is
  // usually smaller than the remote screen, so fit it by default.
  view_style: "adaptive",
  scroll_style: "scrollauto",
  image_quality: "balanced",
  "codec-preference": "auto",
  custom_image_quality: "50",
  "custom-fps": "30",
  keyboard_mode: "legacy",
  reverse_mouse_wheel: "",
  displays_as_individual_windows: "",
  "edge-scroll-edge-thickness": "10",
  swap_left_right_mouse: "",
};

// Toggle options are stored as "Y"/"N" like PeerConfig; absent = default.
const TOGGLE_DEFAULTS: Record<string, boolean> = {
  "show-remote-cursor": false,
  "disable-audio": false,
  "disable-clipboard": false,
  "lock-after-session-end": false,
  "privacy-mode": false,
  "view-only": false,
  "show-quality-monitor": false,
  "follow-remote-cursor": false,
  "follow-remote-window": false,
  "enable-file-copy-paste": false,
  "show-my-cursor": false,
  "allow_swap_key": false,
  "swap-left-right-mouse": false,
  "disable-camera": false,
  "terminal-persistent": false,
  "allow-remote-config-modification": false,
};

export interface PeerInfoRecord {
  id: string;
  username: string;
  hostname: string;
  platform: string;
  alias: string;
  tags: string[];
  lastConnected: number;
}

export class PeerStore {
  private readonly options: Namespace;
  private readonly flutter: Namespace;
  constructor(readonly id: string) {
    this.options = new Namespace(`rd:peer:${id}:options`);
    this.flutter = new Namespace(`rd:peer:${id}:flutter`);
  }

  getOption(name: string): string {
    return this.options.get(name);
  }
  setOption(name: string, value: string): void {
    this.options.set(name, value);
  }

  getFlutterOption(name: string): string {
    return this.flutter.get(name);
  }
  setFlutterOption(name: string, value: string): void {
    this.flutter.set(name, value);
  }

  // option:session — peer option, then user default, then builtin default.
  getSessionOption(name: string): string {
    const v = this.options.get(name);
    if (v !== "") return v;
    const u = userDefaultOptions.get(name);
    if (u !== "") return u;
    return SESSION_DEFAULTS[name] ?? "";
  }

  getToggle(name: string): boolean {
    const v = this.options.get(name);
    if (v === "Y") return true;
    if (v === "N") return false;
    const u = userDefaultOptions.get(name);
    if (u === "Y") return true;
    if (u === "N") return false;
    return TOGGLE_DEFAULTS[name] ?? false;
  }
  setToggle(name: string, on: boolean): void {
    this.options.set(name, on ? "Y" : "N");
  }

  // "remembered" password = SHA256(password || salt), base64. Never the raw one.
  getHashedPassword(): Uint8Array | null {
    const b64 = this.options.get("password");
    if (!b64) return null;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  setHashedPassword(p: Uint8Array | null): void {
    if (!p || p.length === 0) {
      this.options.set("password", "");
      return;
    }
    let s = "";
    for (const b of p) s += String.fromCharCode(b);
    this.options.set("password", btoa(s));
  }

  info(): PeerInfoRecord | null {
    const raw = this.options.get("__info");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PeerInfoRecord;
    } catch {
      return null;
    }
  }
  setInfo(rec: PeerInfoRecord): void {
    this.options.set("__info", JSON.stringify(rec));
    const idx = readDict("rd:peers");
    idx[this.id] = String(rec.lastConnected);
    writeDict("rd:peers", idx);
  }

  static exists(id: string): boolean {
    return readDict("rd:peers")[id] !== undefined;
  }

  static remove(id: string): void {
    const idx = readDict("rd:peers");
    delete idx[id];
    writeDict("rd:peers", idx);
    const s = storage();
    s?.removeItem(`rd:peer:${id}:options`);
    s?.removeItem(`rd:peer:${id}:flutter`);
  }

  static recent(): PeerInfoRecord[] {
    const idx = readDict("rd:peers");
    const out: PeerInfoRecord[] = [];
    for (const id of Object.keys(idx)) {
      const rec = new PeerStore(id).info();
      if (rec) out.push(rec);
    }
    out.sort((a, b) => b.lastConnected - a.lastConnected);
    return out;
  }
}

function randomDigits(n: number): string {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < n; i++) s += String(buf[i]! % 10);
  if (s.startsWith("0")) s = "1" + s.slice(1);
  return s;
}

// Rust Config::get_id(): stable per-install id. A browser has no machine id,
// so it is random once and then persisted.
export function myId(): string {
  let id = localOptions.get("my_id");
  if (!id) {
    id = randomDigits(9);
    localOptions.set("my_id", id);
  }
  return id;
}

export function myUuid(): string {
  let u = localOptions.get("uuid");
  if (!u) {
    u = crypto.randomUUID();
    localOptions.set("uuid", u);
  }
  return u;
}

export function localOs(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  const p = (nav?.userAgentData?.platform ?? nav?.platform ?? "").toLowerCase();
  if (p.includes("win")) return "Windows";
  if (p.includes("mac")) return "Mac OS";
  if (p.includes("linux")) return "Linux";
  if (p.includes("android")) return "Android";
  if (p.includes("iphone") || p.includes("ipad") || p.includes("ios")) return "iOS";
  return "Web";
}

export function myName(): string {
  const n = localOptions.get("my_name");
  return n || `Web (${localOs()})`;
}

// Rust: `Config::get_option("key")`, base64 ed25519 pk of the rendezvous
// server. Empty means unverifiable identity -> insecure sessions.
export function serverKey(): string {
  return globalOptions.get("key").trim();
}

export function rendezvousServer(): string {
  return globalOptions.get("custom-rendezvous-server").trim();
}

export function relayServerOption(): string {
  return globalOptions.get("relay-server").trim();
}

export function apiServer(): string {
  return globalOptions.get("api-server").trim();
}

export function accessToken(): string {
  return localOptions.get("access_token");
}

export function isInputSourceLegacyAllowed(): boolean {
  // "Input source 1" = rdev (map/translate only); "Input source 2" = legacy + map.
  // A browser has no rdev, so default to source 2 unless the user changed it.
  const v = localOptions.get("input-source");
  return v === "" || v === "Input source 2";
}

// Deployment defaults served as /rd-config.js (see docker/10-rd-config.sh):
//   window.RD_CONFIG = { idServer, apiServer, relayServer, key, iceServers, force }
// Applied at init. Without `force`, only options the user has not set yet
// are filled in, so a deployment can seed servers while people keep their
// own changes.
export interface RuntimeConfig {
  idServer?: string;
  apiServer?: string;
  relayServer?: string;
  key?: string;
  iceServers?: string;
  force?: boolean;
}

export function applyRuntimeConfig(): void {
  const cfg = (globalThis as { RD_CONFIG?: RuntimeConfig }).RD_CONFIG;
  if (!cfg || typeof cfg !== "object") return;
  const pairs: Array<[string, string | undefined]> = [
    ["custom-rendezvous-server", cfg.idServer],
    ["api-server", cfg.apiServer],
    ["relay-server", cfg.relayServer],
    ["key", cfg.key],
    ["ice-servers", cfg.iceServers],
  ];
  for (const [name, value] of pairs) {
    if (typeof value !== "string" || value === "") continue;
    if (cfg.force || globalOptions.get(name) === "") globalOptions.set(name, value);
  }
  log.info("runtime config applied", cfg.force ? "(forced)" : "(defaults)");
}
