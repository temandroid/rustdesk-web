// WebSocket transport matching hbb_common websocket.rs WsFramedStream:
// one binary WebSocket message == one protobuf message (no length prefix),
// optional secretbox encryption after set_key. Text frames pass through as bytes.
import { Encrypt } from "../crypto";
import { log } from "../log";

export const RENDEZVOUS_PORT = 21116;
export const RELAY_PORT = 21117;

export type WsKind = "id" | "relay";

export interface WsUrlOptions {
  // Force wss for domain hosts (page served over https, or api-server https).
  secure?: boolean;
}

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.startsWith("[") || /^[0-9a-f:]+$/i.test(host) && host.includes(":");
}

export function splitHostPort(endpoint: string): { host: string; port: number | null } {
  const e = endpoint.trim();
  if (e.startsWith("[")) {
    const close = e.indexOf("]");
    if (close > 0) {
      const host = e.slice(0, close + 1);
      const rest = e.slice(close + 1);
      const port = rest.startsWith(":") ? parseInt(rest.slice(1), 10) : NaN;
      return { host, port: Number.isFinite(port) ? port : null };
    }
  }
  const colons = e.split(":").length - 1;
  if (colons === 1) {
    const [host, p] = e.split(":");
    const port = parseInt(p ?? "", 10);
    return { host: host ?? e, port: Number.isFinite(port) ? port : null };
  }
  if (colons > 1) {
    // bare IPv6 without brackets and without port
    return { host: `[${e}]`, port: null };
  }
  return { host: e, port: null };
}

// Port of websocket.rs check_ws for the two endpoints a controller uses.
//   domain -> ws(s)://host/ws/id | /ws/relay   (reverse-proxy layout)
//   ip     -> ws://ip:<port+2>                  (21116 -> 21118, 21117 -> 21119)
export function buildWsUrl(endpoint: string, kind: WsKind, opts: WsUrlOptions = {}): string {
  return buildWsUrlCandidates(endpoint, kind, opts)[0]!;
}

// All URLs worth trying for an endpoint, most likely first. hbbs/hbbr also
// listen for plain WebSocket on the raw ports (21118/21119) without a proxy,
// which is what the v1 web client used; try that when the path form fails and
// the page is not https (a raw hbbs port has no TLS, so wss:// cannot work).
export function buildWsUrlCandidates(endpoint: string, kind: WsKind, opts: WsUrlOptions = {}): string[] {
  const e = endpoint.trim();
  if (e === "") throw new Error("empty server address");
  // Explicit ws(s) URL ("proxy mode"): an origin gets /ws/<kind> appended, a
  // URL that already carries a path is used verbatim.
  if (/^wss?:\/\//i.test(e)) {
    const u = new URL(e);
    if (u.pathname === "/" || u.pathname === "") u.pathname = `/ws/${kind}`;
    return [u.toString().replace(/\/$/, "")];
  }
  const { host, port } = splitHostPort(e);
  const basePort = port ?? (kind === "id" ? RENDEZVOUS_PORT : RELAY_PORT);
  const scheme = opts.secure ? "wss" : "ws";
  if (isIpLiteral(host)) {
    return [`${scheme}://${host}:${basePort + 2}`];
  }
  const out = [`${scheme}://${host}/ws/${kind}`];
  if (!pageIsHttps()) out.push(`ws://${host}:${basePort + 2}`);
  return out;
}

// True when the configured endpoint is an explicit ws(s) URL, i.e. the user
// points the client at a proxy that also fronts the relay under /ws/relay.
export function isExplicitWsEndpoint(endpoint: string): boolean {
  return /^wss?:\/\//i.test(endpoint.trim());
}

export function pageIsHttps(): boolean {
  try {
    return globalThis.location?.protocol === "https:";
  } catch {
    return false;
  }
}

export async function connectFirst(urls: string[], timeoutMs: number): Promise<WsStream> {
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      return await WsStream.connect(url, timeoutMs);
    } catch (e) {
      log.warn(`connect failed: ${url}`, e);
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to connect to ${urls.join(" / ")}`);
}

export class WsClosedError extends Error {
  constructor(msg = "Reset by the peer") {
    super(msg);
    this.name = "WsClosedError";
  }
}

export class WsTimeoutError extends Error {
  constructor(msg = "Timeout") {
    super(msg);
    this.name = "WsTimeoutError";
  }
}

type Waiter = { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: number };

export class WsStream {
  private encrypt: Encrypt | null = null;
  private queue: Uint8Array[] = [];
  private waiters: Waiter[] = [];
  private closed: Error | null = null;
  onClose: ((e: Error) => void) | null = null;

  private constructor(private readonly ws: WebSocket, readonly url: string) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = (ev) => this.fail(new WsClosedError(ev.code === 1000 ? "Reset by the peer" : `WebSocket closed (${ev.code})`));
    ws.onerror = () => this.fail(new WsClosedError("WebSocket error"));
  }

  static connect(url: string, timeoutMs: number): Promise<WsStream> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new Error(`Failed to open ${url}: ${String(e)}`));
        return;
      }
      const timer = setTimeout(() => {
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new WsTimeoutError(`Timeout connecting to ${url}`));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new WsStream(ws, url));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${url}`));
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        reject(new Error(`Connection to ${url} closed (${ev.code})`));
      };
    });
  }

  get isSecured(): boolean {
    return this.encrypt !== null;
  }

  setKey(key: Uint8Array): void {
    this.encrypt = new Encrypt(key);
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  send(bytes: Uint8Array): void {
    if (this.closed) throw this.closed;
    const payload = this.encrypt ? this.encrypt.enc(bytes) : bytes;
    this.ws.send(payload);
  }

  next(timeoutMs = 0): Promise<Uint8Array> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        timer: timeoutMs > 0
          ? (setTimeout(() => {
              this.waiters = this.waiters.filter((x) => x !== w);
              reject(new WsTimeoutError());
            }, timeoutMs) as unknown as number)
          : 0,
      };
      this.waiters.push(w);
    });
  }

  close(): void {
    if (!this.closed) this.closed = new WsClosedError("Closed");
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch {
      /* ignore */
    }
    this.ws.onmessage = null;
    this.flushWaiters();
  }

  private onMessage(ev: MessageEvent): void {
    let bytes: Uint8Array;
    if (ev.data instanceof ArrayBuffer) {
      bytes = new Uint8Array(ev.data);
    } else if (typeof ev.data === "string") {
      bytes = new TextEncoder().encode(ev.data);
    } else {
      return;
    }
    if (this.encrypt) {
      try {
        bytes = this.encrypt.dec(bytes);
      } catch (e) {
        log.error("decryption error", e);
        this.fail(new WsClosedError("decryption error"));
        return;
      }
    }
    const w = this.waiters.shift();
    if (w) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve(bytes);
    } else {
      this.queue.push(bytes);
    }
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = e;
    this.flushWaiters();
    this.onClose?.(e);
  }

  private flushWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(this.closed ?? new WsClosedError());
    }
  }
}
