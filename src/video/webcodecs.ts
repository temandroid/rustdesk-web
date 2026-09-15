// WebCodecs decode path. Frames on the wire are bare elementary streams:
// VP8/VP9 raw frames, AV1 low-overhead OBUs, H264/H265 Annex B with in-band
// parameter sets (libs/scrap: vpxcodec.rs, aom.rs, hwcodec.rs). pts is in ms.
import { create } from "@bufbuild/protobuf";
import {
  type VideoFrame as PbVideoFrame,
  type EncodedVideoFrames,
  SupportedDecodingSchema,
  SupportedDecoding_PreferCodec,
  Chroma,
  CodecAbilitySchema,
  type SupportedDecoding,
} from "../proto/message_pb";
import { log } from "../log";

export type CodecName = "vp8" | "vp9" | "av1" | "h264" | "h265";

export interface CodecAbilities {
  vp8: boolean;
  vp9: boolean;
  av1: boolean;
  h264: boolean;
  h265: boolean;
}

// Codec strings carry a level. Hardware decoders size their output from it,
// so a low level (e.g. avc1.42E01E = Baseline 3.0, max 720p) makes a 1080p
// stream come out cropped to 1280x720. Declare generous levels: H264 High 5.1,
// HEVC Main 5.1, VP9 profile 0 level 5.1, AV1 Main level 5.1 (all up to 4K).
const CONFIGS: Record<CodecName, VideoDecoderConfig> = {
  vp8: { codec: "vp8" },
  vp9: { codec: "vp09.00.51.08" },
  av1: { codec: "av01.0.13M.08" },
  h264: { codec: "avc1.640033", avc: { format: "annexb" } } as VideoDecoderConfig,
  h265: { codec: "hev1.1.6.L153.B0", hevc: { format: "annexb" } } as VideoDecoderConfig,
};

export function hasWebCodecs(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function";
}

let probed: CodecAbilities | null = null;

export async function probeCodecs(): Promise<CodecAbilities> {
  if (probed) return probed;
  const out: CodecAbilities = { vp8: false, vp9: false, av1: false, h264: false, h265: false };
  if (!hasWebCodecs()) {
    probed = out;
    return out;
  }
  for (const name of Object.keys(CONFIGS) as CodecName[]) {
    try {
      const r = await VideoDecoder.isConfigSupported({ ...CONFIGS[name], optimizeForLatency: true });
      out[name] = !!r.supported;
    } catch {
      out[name] = false;
    }
  }
  probed = out;
  log.info("codec support", out);
  return out;
}

export function preferFromOption(v: string): SupportedDecoding_PreferCodec {
  switch (v) {
    case "vp8":
      return SupportedDecoding_PreferCodec.VP8;
    case "vp9":
      return SupportedDecoding_PreferCodec.VP9;
    case "av1":
      return SupportedDecoding_PreferCodec.AV1;
    case "h264":
      return SupportedDecoding_PreferCodec.H264;
    case "h265":
      return SupportedDecoding_PreferCodec.H265;
    default:
      return SupportedDecoding_PreferCodec.Auto;
  }
}

// Mirrors scrap codec.rs Decoder::supported_decodings for a browser: abilities
// come from isConfigSupported, minus codecs that failed at runtime.
export function buildSupportedDecoding(
  abilities: CodecAbilities,
  unsupported: Set<CodecName>,
  prefer: string
): SupportedDecoding {
  const ok = (c: CodecName) => (abilities[c] && !unsupported.has(c) ? 1 : 0);
  return create(SupportedDecodingSchema, {
    abilityVp8: ok("vp8"),
    abilityVp9: ok("vp9"),
    abilityAv1: ok("av1"),
    abilityH264: ok("h264"),
    abilityH265: ok("h265"),
    prefer: preferFromOption(prefer),
    preferChroma: Chroma.I420,
    i444: create(CodecAbilitySchema, { vp8: false, vp9: false, av1: false, h264: false, h265: false }),
  });
}

export function codecOf(vf: PbVideoFrame): { codec: CodecName; frames: EncodedVideoFrames } | null {
  switch (vf.union.case) {
    case "vp8s":
      return { codec: "vp8", frames: vf.union.value };
    case "vp9s":
      return { codec: "vp9", frames: vf.union.value };
    case "av1s":
      return { codec: "av1", frames: vf.union.value };
    case "h264s":
      return { codec: "h264", frames: vf.union.value };
    case "h265s":
      return { codec: "h265", frames: vf.union.value };
    default:
      return null;
  }
}

export interface VideoSink {
  // Zero-copy handoff (Dart owns and closes the frame). Return false if the
  // sink is not installed, in which case the pipeline falls back to RGBA.
  onVideoFrame(display: number, frame: VideoFrame): boolean;
  onRgba(display: number, rgba: Uint8Array, width: number, height: number): boolean;
  expectedSize(display: number): { width: number; height: number } | null;
  onDecoderError(display: number, codec: CodecName, err: unknown): void;
  requestKeyframe(display: number): void;
}

interface DisplayDecoder {
  codec: CodecName;
  decoder: VideoDecoder;
  gotKey: boolean;
  frames: number;
  rgbaInFlight: boolean;
  canvas: OffscreenCanvas | null;
}

export class VideoPipeline {
  private decoders = new Map<number, DisplayDecoder>();
  private fpsCount = new Map<number, number>();
  private warnedCrop = new Set<number>();
  private closed = false;

  constructor(private readonly sink: VideoSink) {}

  handle(vf: PbVideoFrame): void {
    if (this.closed) return;
    const c = codecOf(vf);
    if (!c) {
      log.warn("unsupported VideoFrame union", vf.union.case);
      return;
    }
    const display = vf.display;
    let d = this.decoders.get(display);
    if (d && (d.codec !== c.codec || d.decoder.state === "closed")) {
      this.dropDecoder(display);
      d = undefined;
    }
    if (!d) {
      const created = this.createDecoder(display, c.codec);
      if (!created) return;
      d = created;
    }
    for (const f of c.frames.frames) {
      if (!d.gotKey) {
        if (!f.key) {
          this.sink.requestKeyframe(display);
          continue;
        }
        d.gotKey = true;
      }
      const chunk = new EncodedVideoChunk({
        type: f.key ? "key" : "delta",
        timestamp: Number(f.pts) * 1000,
        data: f.data,
      });
      try {
        d.decoder.decode(chunk);
      } catch (e) {
        this.onError(display, d, e);
        return;
      }
    }
  }

  reset(display: number): void {
    this.dropDecoder(display);
  }

  close(): void {
    this.closed = true;
    for (const k of [...this.decoders.keys()]) this.dropDecoder(k);
  }

  // Frames decoded since the last call, per display.
  takeFps(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.fpsCount) out[String(k)] = v;
    this.fpsCount.clear();
    return out;
  }

  private createDecoder(display: number, codec: CodecName): DisplayDecoder | null {
    if (!hasWebCodecs()) {
      this.sink.onDecoderError(display, codec, new Error("WebCodecs unavailable"));
      return null;
    }
    const entry: DisplayDecoder = {
      codec,
      decoder: null as unknown as VideoDecoder,
      gotKey: false,
      frames: 0,
      rgbaInFlight: false,
      canvas: null,
    };
    const decoder = new VideoDecoder({
      output: (frame) => this.onOutput(display, entry, frame),
      error: (e) => this.onError(display, entry, e),
    });
    try {
      decoder.configure({ ...CONFIGS[codec], optimizeForLatency: true });
    } catch (e) {
      this.sink.onDecoderError(display, codec, e);
      return null;
    }
    entry.decoder = decoder;
    this.decoders.set(display, entry);
    log.info(`decoder ${codec} created for display ${display}`);
    return entry;
  }

  private dropDecoder(display: number): void {
    const d = this.decoders.get(display);
    if (!d) return;
    this.decoders.delete(display);
    try {
      if (d.decoder.state !== "closed") d.decoder.close();
    } catch {
      /* ignore */
    }
  }

  private onError(display: number, d: DisplayDecoder, e: unknown): void {
    log.error(`decoder ${d.codec} error on display ${display}`, e);
    this.dropDecoder(display);
    this.sink.onDecoderError(display, d.codec, e);
  }

  private onOutput(display: number, d: DisplayDecoder, frame: VideoFrame): void {
    if (this.closed || this.decoders.get(display) !== d) {
      frame.close();
      return;
    }
    frame = this.fixVisibleRect(display, frame);
    d.frames++;
    if (d.frames === 1) {
      const want = this.sink.expectedSize(display);
      log.info(
        `first frame display ${display}: ${frame.displayWidth}x${frame.displayHeight} (coded ${frame.codedWidth}x${frame.codedHeight}), display info ${want ? `${want.width}x${want.height}` : "unknown"}, dpr ${globalThis.devicePixelRatio ?? "?"}`
      );
    }
    this.fpsCount.set(display, (this.fpsCount.get(display) ?? 0) + 1);
    if (this.sink.onVideoFrame(display, frame)) return;
    // RGBA fallback. No flow control from Dart, so keep one readback in flight.
    if (d.rgbaInFlight) {
      frame.close();
      return;
    }
    d.rgbaInFlight = true;
    void this.readbackRgba(display, d, frame).finally(() => {
      d.rgbaInFlight = false;
    });
  }

  // Safety net for a stale/undersized crop window: if the decoder reports a
  // visible rect smaller than the display while the coded picture is at least
  // display-sized, re-wrap the frame with a display-sized visible rect.
  private fixVisibleRect(display: number, frame: VideoFrame): VideoFrame {
    const want = this.sink.expectedSize(display);
    if (!want) return frame;
    const vr = frame.visibleRect;
    if (!vr) return frame;
    if (vr.width >= want.width && vr.height >= want.height) return frame;
    if (frame.codedWidth < want.width || frame.codedHeight < want.height) return frame;
    try {
      const fixed = new VideoFrame(frame, {
        visibleRect: { x: 0, y: 0, width: want.width, height: want.height },
      });
      frame.close();
      if (!this.warnedCrop.has(display)) {
        this.warnedCrop.add(display);
        log.warn(`display ${display}: decoder visible rect ${vr.width}x${vr.height} < display ${want.width}x${want.height} (coded ${frame.codedWidth}x${frame.codedHeight}); expanded`);
      }
      return fixed;
    } catch (e) {
      log.warn("visibleRect fix failed", e);
      return frame;
    }
  }

  private async readbackRgba(display: number, d: DisplayDecoder, frame: VideoFrame): Promise<void> {
    try {
      const want = this.sink.expectedSize(display);
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      const w = want?.width ?? fw;
      const h = want?.height ?? fh;
      let rgba: Uint8Array;
      if (w === fw && h === fh && typeof frame.copyTo === "function") {
        try {
          const size = frame.allocationSize({ format: "RGBA" } as VideoFrameCopyToOptions);
          rgba = new Uint8Array(size);
          await frame.copyTo(rgba, { format: "RGBA" } as VideoFrameCopyToOptions);
          this.sink.onRgba(display, rgba, w, h);
          return;
        } catch {
          // Some engines refuse format conversion in copyTo; draw instead.
        }
      }
      if (!d.canvas || d.canvas.width !== w || d.canvas.height !== h) {
        d.canvas = new OffscreenCanvas(w, h);
      }
      const ctx = d.canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(frame, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      rgba = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
      this.sink.onRgba(display, rgba, w, h);
    } catch (e) {
      log.error("rgba readback failed", e);
    } finally {
      frame.close();
    }
  }
}
