// Port of src/client.rs AudioHandler for the browser: the peer sends one
// AudioFormat (sample rate, channels) and then AudioFrame messages, each a
// single Opus packet. Packets are decoded with WebCodecs AudioDecoder and
// played through an AudioContext, scheduled back to back with a small lead.
import { log } from "./log";

// Lead time before the first packet of a burst plays, and the most audio we
// let queue up before dropping to catch up with the picture.
const START_LEAD_S = 0.06;
const MAX_QUEUED_S = 0.5;

interface AudioCtor {
  AudioDecoder?: typeof AudioDecoder;
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

function ctors(): AudioCtor {
  return globalThis as unknown as AudioCtor;
}

/** True when the browser can decode Opus and play PCM at all. */
export function audioSupported(): boolean {
  const g = ctors();
  return typeof g.AudioDecoder === "function" && typeof (g.AudioContext ?? g.webkitAudioContext) === "function";
}

// is_supported_audio_channel_count
export function supportedChannels(n: number): boolean {
  return n === 1 || n === 2;
}

/** Copies decoded audio into one Float32Array per channel. */
export function planarChannels(data: AudioData): Float32Array[] {
  const frames = data.numberOfFrames;
  const channels = data.numberOfChannels;
  const out: Float32Array[] = [];
  if (data.format === "f32-planar") {
    for (let c = 0; c < channels; c++) {
      const buf = new Float32Array(frames);
      data.copyTo(buf, { planeIndex: c });
      out.push(buf);
    }
    return out;
  }
  if (data.format === "f32") {
    const inter = new Float32Array(frames * channels);
    data.copyTo(inter, { planeIndex: 0 });
    return deinterleave(inter, channels);
  }
  // Other sample formats: let the browser convert (supported where copyTo
  // takes a format; otherwise the frame is skipped by the caller).
  for (let c = 0; c < channels; c++) {
    const buf = new Float32Array(frames);
    data.copyTo(buf, { planeIndex: c, format: "f32-planar" });
    out.push(buf);
  }
  return out;
}

export function deinterleave(inter: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(inter.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[c]![i] = inter[i * channels + c]!;
  }
  return out;
}

/** Where the next buffer starts, or null when it should be dropped. */
export function nextStart(playAt: number, now: number, duration: number): number | null {
  if (playAt < now + 0.005) return now + START_LEAD_S;
  if (playAt + duration - now > MAX_QUEUED_S) return null;
  return playAt;
}

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private decoder: AudioDecoder | null = null;
  private playAt = 0;
  private timestampUs = 0;
  private muted = false;
  private closed = false;
  private warned = false;
  private readonly unlock = () => void this.ctx?.resume().catch(() => {});

  constructor() {
    // Autoplay policy: an AudioContext created without a user gesture starts
    // suspended. Any click or key press in the page lets it play.
    globalThis.addEventListener?.("pointerdown", this.unlock, true);
    globalThis.addEventListener?.("keydown", this.unlock, true);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.playAt = 0;
  }

  // AudioHandler::handle_format
  handleFormat(sampleRate: number, channels: number): void {
    if (this.closed) return;
    if (!supportedChannels(channels)) {
      log.error(`unsupported audio channel count: ${channels}`);
      return;
    }
    if (!audioSupported()) {
      if (!this.warned) log.warn("audio: this browser has no WebCodecs AudioDecoder; sound stays off");
      this.warned = true;
      return;
    }
    const g = ctors();
    this.decoder?.close();
    this.decoder = null;
    if (!this.ctx) {
      const Ctx = (g.AudioContext ?? g.webkitAudioContext)!;
      this.ctx = new Ctx({ latencyHint: "interactive" });
    }
    const decoder = new g.AudioDecoder!({
      output: (data) => this.play(data),
      error: (e) => log.warn("audio decoder error", e),
    });
    try {
      decoder.configure({ codec: "opus", sampleRate, numberOfChannels: channels });
    } catch (e) {
      log.warn("audio: opus decoder not available", e);
      decoder.close();
      return;
    }
    this.decoder = decoder;
    this.playAt = 0;
    this.timestampUs = 0;
    log.info(`audio: opus ${sampleRate} Hz, ${channels} ch`);
  }

  // AudioHandler::handle_frame
  handleFrame(packet: Uint8Array): void {
    const d = this.decoder;
    if (!d || this.closed || this.muted || d.state !== "configured" || packet.length === 0) return;
    // Opus packets are self-contained; timestamps only need to grow.
    const chunk = new EncodedAudioChunk({ type: "key", timestamp: this.timestampUs, data: packet });
    this.timestampUs += 10_000;
    try {
      d.decode(chunk);
    } catch (e) {
      log.warn("audio decode failed", e);
    }
  }

  private play(data: AudioData): void {
    try {
      const ctx = this.ctx;
      if (!ctx || this.closed || this.muted || ctx.state !== "running") return;
      let channels: Float32Array[];
      try {
        channels = planarChannels(data);
      } catch {
        return;
      }
      const frames = channels[0]?.length ?? 0;
      if (frames === 0) return;
      const buffer = ctx.createBuffer(channels.length, frames, data.sampleRate);
      channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
      const start = nextStart(this.playAt, ctx.currentTime, buffer.duration);
      if (start === null) {
        // Too far behind the picture: drop and restart the queue.
        this.playAt = 0;
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(start);
      this.playAt = start + buffer.duration;
    } finally {
      data.close();
    }
  }

  close(): void {
    this.closed = true;
    globalThis.removeEventListener?.("pointerdown", this.unlock, true);
    globalThis.removeEventListener?.("keydown", this.unlock, true);
    try {
      this.decoder?.close();
    } catch {
      /* already closed */
    }
    this.decoder = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
