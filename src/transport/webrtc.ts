// WebRTC data-channel transport matching hbb_common webrtc.rs WebRTCStream:
//   endpoint  : "webrtc://" + base64(JSON {type, sdp, ice_policy?: "all"})
//               (trickle form: candidate lines stripped, candidates follow as
//               RendezvousMessage.ice_candidate)
//   channel   : offerer creates "bootstrap", ordered + reliable
//   framing   : each SCTP message = 1 header byte (0 = last fragment, 1 = more)
//               + up to 60000 payload bytes; logical messages are reassembled
//   security  : DTLS only. There is no secretbox layer; identity is bound by
//               comparing the peer-signed fingerprint with the remote SDP's
//               a=fingerprint value. set_key() just marks the peer verified.
//   liveness  : pc connection state
import { log } from "../log";

export const DEFAULT_ICE_SERVERS = [
  "stun:stun.cloudflare.com:3478",
  "stun:stun.l.google.com:19302",
  "stun:stun.antisip.com:3478",
  "stun:stun.nextcloud.com:443",
];

const MAX_FRAGMENT_PAYLOAD = 60000;
const FRAG_MORE = 1;
const FRAG_END = 0;
// bytes_codec.rs MAX_FRAME_LENGTH
const MAX_RECV_MESSAGE = 0x3fff_ffff;
const ENDPOINT_PREFIX = "webrtc://";
const WEBRTC_SUSPECT_GRACE_MS = 3000;

export class WebRtcClosedError extends Error {
  constructor(msg = "WebRTC connection closed") {
    super(msg);
    this.name = "WebRtcClosedError";
  }
}

export class WebRtcTimeoutError extends Error {
  constructor(msg = "Timeout") {
    super(msg);
    this.name = "WebRtcTimeoutError";
  }
}

interface Envelope {
  type: RTCSdpType;
  sdp: string;
  ice_policy?: string;
}

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeEndpoint(type: RTCSdpType, sdp: string, relayOnly: boolean): string {
  const env: Envelope = { type, sdp };
  if (!relayOnly) env.ice_policy = "all";
  return ENDPOINT_PREFIX + b64encode(JSON.stringify(env));
}

export function decodeEndpoint(endpoint: string): Envelope {
  if (!endpoint.startsWith(ENDPOINT_PREFIX)) throw new Error("Invalid WebRTC endpoint format");
  const env = JSON.parse(b64decode(endpoint.slice(ENDPOINT_PREFIX.length))) as Envelope;
  if (typeof env.sdp !== "string" || typeof env.type !== "string") throw new Error("Invalid WebRTC endpoint envelope");
  return env;
}

export function endpointDeclaresAllIce(endpoint: string): boolean {
  try {
    return decodeEndpoint(endpoint).ice_policy === "all";
  } catch {
    return false;
  }
}

// webrtc.rs get_key_for_sdp: the value of the session-level a=fingerprint
// (before the first m= line), else the one inside the m=application section.
export function fingerprintFromSdp(sdp: string): string | null {
  let section: "session" | "application" | "other" = "session";
  let fromApp: string | null = null;
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      section = line.startsWith("m=application") ? "application" : "other";
      continue;
    }
    if (!line.startsWith("a=fingerprint:")) continue;
    const v = line.slice("a=fingerprint:".length).trim();
    if (section === "session") return v;
    if (section === "application" && fromApp === null) fromApp = v;
  }
  return fromApp;
}

// webrtc.rs trickle_endpoint: strip candidate lines, candidates go separately.
function stripCandidates(sdp: string): string {
  return (
    sdp
      .split(/\r?\n/)
      .filter((l) => l.length > 0 && !l.startsWith("a=candidate:") && !l.startsWith("a=end-of-candidates"))
      .join("\r\n") + "\r\n"
  );
}

// webrtc.rs get_ice_server_from_url: stun/stuns/turn/turns URLs; turn needs
// credentials, given as turn://user:pass@host:port.
export function parseIceServer(url: string): RTCIceServer | null {
  const m = /^(stun|stuns|turn|turns):(\/\/)?(?:([^:@/]+):([^@/]*)@)?(.+)$/.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!;
  const user = m[3];
  const pass = m[4];
  const hostPort = m[5]!;
  if ((scheme === "turn" || scheme === "turns") && (!user || !pass)) return null;
  const server: RTCIceServer = { urls: `${scheme}:${hostPort}` };
  if (user) {
    server.username = user;
    server.credential = pass;
  }
  return server;
}

export function buildIceServers(custom: string[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  let hasStun = false;
  for (const u of custom) {
    const s = parseIceServer(u);
    if (!s) continue;
    if (String(s.urls).startsWith("stun")) hasStun = true;
    out.push(s);
  }
  if (!hasStun) for (const u of DEFAULT_ICE_SERVERS) out.push({ urls: u });
  return out;
}

type Waiter = { resolve: (b: Uint8Array) => void; reject: (e: Error) => void; timer: number };

export class WebRtcStream {
  private dc: RTCDataChannel | null = null;
  private queue: Uint8Array[] = [];
  private waiters: Waiter[] = [];
  private closed: Error | null = null;
  private acc: Uint8Array[] = [];
  private accLen = 0;
  private openResolvers: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private opened = false;
  private verified = false;
  private suspectTimer: number | null = null;
  readonly localEndpoint: string;
  readonly sessionKey: string;
  onClose: ((e: Error) => void) | null = null;
  onIceCandidate: ((candidateJson: string) => void) | null = null;

  private constructor(
    readonly pc: RTCPeerConnection,
    readonly relayOnly: boolean,
    localEndpoint: string,
    sessionKey: string
  ) {
    this.localEndpoint = localEndpoint;
    this.sessionKey = sessionKey;
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const json = JSON.stringify(ev.candidate.toJSON());
      this.onIceCandidate?.(json);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "failed" || st === "closed") {
        this.fail(new WebRtcClosedError(`WebRTC connection ${st}`));
      } else if (st === "disconnected") {
        // io_loop.rs WEBRTC_SUSPECT_GRACE: "disconnected" is often transient
        if (this.suspectTimer === null) {
          this.suspectTimer = setTimeout(() => {
            this.suspectTimer = null;
            if (pc.connectionState === "disconnected") this.fail(new WebRtcClosedError("WebRTC connection lost"));
          }, WEBRTC_SUSPECT_GRACE_MS) as unknown as number;
        }
      } else if (this.suspectTimer !== null) {
        clearTimeout(this.suspectTimer);
        this.suspectTimer = null;
      }
    };
  }

  // Controller side: create the offer with a trickle-ICE endpoint.
  static async createOffer(iceServers: RTCIceServer[], relayOnly: boolean): Promise<WebRtcStream> {
    const pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
    });
    const dc = pc.createDataChannel("bootstrap");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
    const fp = fingerprintFromSdp(sdp);
    if (!fp) {
      pc.close();
      throw new Error("SDP fingerprint attribute not found");
    }
    const stream = new WebRtcStream(pc, relayOnly, encodeEndpoint("offer", stripCandidates(sdp), relayOnly), fp);
    stream.attachChannel(dc);
    return stream;
  }

  // Answerer side (used by the loopback test; the controller is always the offerer).
  static async createAnswer(iceServers: RTCIceServer[], remoteEndpoint: string): Promise<WebRtcStream> {
    const env = decodeEndpoint(remoteEndpoint);
    const relayOnly = env.ice_policy !== "all";
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
    const ready = new Promise<RTCDataChannel>((resolve) => {
      pc.ondatachannel = (ev) => resolve(ev.channel);
    });
    await pc.setRemoteDescription({ type: env.type, sdp: env.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const key = fingerprintFromSdp(env.sdp) ?? "";
    const stream = new WebRtcStream(pc, relayOnly, encodeEndpoint("answer", stripCandidates(pc.localDescription?.sdp ?? ""), relayOnly), key);
    void ready.then((dc) => stream.attachChannel(dc));
    return stream;
  }

  private attachChannel(dc: RTCDataChannel): void {
    if (this.dc) {
      log.warn(`ignoring extra WebRTC data channel ${dc.label}`);
      return;
    }
    if (!dc.ordered || dc.maxRetransmits !== null || dc.maxPacketLifeTime !== null) {
      log.warn(`rejecting WebRTC data channel ${dc.label}: not ordered and fully reliable`);
      dc.close();
      return;
    }
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      this.opened = true;
      for (const r of this.openResolvers.splice(0)) r.resolve();
    };
    dc.onclose = () => this.fail(new WebRtcClosedError("data channel closed"));
    dc.onerror = (ev) => this.fail(new WebRtcClosedError(`data channel error: ${String((ev as RTCErrorEvent).error?.message ?? "")}`));
    dc.onmessage = (ev) => this.onFragment(ev.data as ArrayBuffer);
    if (dc.readyState === "open") dc.onopen(new Event("open"));
  }

  async setRemoteEndpoint(endpoint: string): Promise<void> {
    const env = decodeEndpoint(endpoint);
    await this.pc.setRemoteDescription({ type: env.type, sdp: env.sdp });
  }

  async addRemoteIceCandidate(candidateJson: string): Promise<void> {
    if (!candidateJson) return;
    const init = JSON.parse(candidateJson) as RTCIceCandidateInit;
    await this.pc.addIceCandidate(init);
  }

  // Fingerprint of the peer's certificate as declared in its SDP; the peer
  // signs the same string into IdPk.dtls_fingerprint.
  remoteDtlsFingerprint(): string | null {
    const sdp = this.pc.remoteDescription?.sdp;
    return sdp ? fingerprintFromSdp(sdp) : null;
  }

  localDtlsFingerprint(): string | null {
    const sdp = this.pc.localDescription?.sdp;
    return sdp ? fingerprintFromSdp(sdp) : null;
  }

  waitConnected(timeoutMs: number): Promise<void> {
    if (this.opened) return Promise.resolve();
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openResolvers = this.openResolvers.filter((r) => r.resolve !== resolve);
        reject(new WebRtcTimeoutError("WebRTC wait_connected timeout"));
      }, timeoutMs);
      this.openResolvers.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  get isConnected(): boolean {
    return this.opened && !this.closed;
  }

  // webrtc.rs is_relayed: whether the nominated candidate pair uses a TURN relay.
  async isRelayed(): Promise<boolean> {
    if (this.relayOnly) return true;
    try {
      const stats = await this.pc.getStats();
      let pair: RTCIceCandidatePairStats | null = null;
      stats.forEach((v) => {
        const r = v as RTCStats & { type: string; selected?: boolean; nominated?: boolean; state?: string };
        if (r.type === "transport") {
          const id = (r as unknown as { selectedCandidatePairId?: string }).selectedCandidatePairId;
          if (id) pair = stats.get(id) as RTCIceCandidatePairStats;
        }
      });
      if (!pair) {
        stats.forEach((v) => {
          const r = v as RTCIceCandidatePairStats & { selected?: boolean };
          if (r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = r;
        });
      }
      if (!pair) return false;
      const p = pair as RTCIceCandidatePairStats;
      const typeOf = (id: string | undefined) => (id ? ((stats.get(id) as (RTCStats & { candidateType?: string }) | undefined)?.candidateType ?? "") : "");
      return typeOf(p.localCandidateId) === "relay" || typeOf(p.remoteCandidateId) === "relay";
    } catch {
      return false;
    }
  }

  get isSecured(): boolean {
    return this.verified;
  }

  // webrtc.rs set_key: no symmetric layer; marks the identity as verified.
  setKey(_key: Uint8Array): void {
    this.verified = true;
  }

  get bufferedAmount(): number {
    return this.dc?.bufferedAmount ?? 0;
  }

  send(bytes: Uint8Array): void {
    if (this.closed) throw this.closed;
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") throw new WebRtcClosedError("data channel not open");
    if (bytes.length > MAX_RECV_MESSAGE) throw new Error("Overflow");
    let offset = 0;
    do {
      const end = Math.min(offset + MAX_FRAGMENT_PAYLOAD, bytes.length);
      const isLast = end >= bytes.length;
      const frame = new Uint8Array(1 + (end - offset));
      frame[0] = isLast ? FRAG_END : FRAG_MORE;
      frame.set(bytes.subarray(offset, end), 1);
      dc.send(frame);
      offset = end;
      if (isLast) break;
    } while (offset < bytes.length);
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
              reject(new WebRtcTimeoutError());
            }, timeoutMs) as unknown as number)
          : 0,
      };
      this.waiters.push(w);
    });
  }

  close(): void {
    if (!this.closed) this.closed = new WebRtcClosedError("Closed");
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.flushWaiters();
  }

  private onFragment(buf: ArrayBuffer): void {
    const frag = new Uint8Array(buf);
    if (frag.length === 0) {
      this.fail(new WebRtcClosedError("WebRTC data channel ended (empty message)"));
      return;
    }
    const header = frag[0]!;
    if (header !== FRAG_END && header !== FRAG_MORE) {
      this.fail(new WebRtcClosedError(`fragment header ${header} is neither FRAG_END nor FRAG_MORE`));
      return;
    }
    if (header === FRAG_MORE && frag.length === 1) {
      this.fail(new WebRtcClosedError("FRAG_MORE fragment carries no payload"));
      return;
    }
    const payload = frag.subarray(1);
    if (this.accLen + payload.length > MAX_RECV_MESSAGE) {
      this.fail(new WebRtcClosedError("WebRTC reassembled message exceeded maximum frame size"));
      return;
    }
    if (header === FRAG_END && this.acc.length === 0) {
      this.deliver(payload);
      return;
    }
    this.acc.push(payload);
    this.accLen += payload.length;
    if (header === FRAG_END) {
      const msg = new Uint8Array(this.accLen);
      let off = 0;
      for (const p of this.acc) {
        msg.set(p, off);
        off += p.length;
      }
      this.acc = [];
      this.accLen = 0;
      this.deliver(msg);
    }
  }

  private deliver(bytes: Uint8Array): void {
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
    for (const r of this.openResolvers.splice(0)) r.reject(e);
    this.flushWaiters();
    this.onClose?.(e);
  }

  private flushWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(this.closed ?? new WebRtcClosedError());
    }
  }
}
