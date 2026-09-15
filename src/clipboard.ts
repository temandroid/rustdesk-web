// Text clipboard sync. Port of the relevant bits of src/clipboard.rs and
// src/client/io_loop.rs for a browser host:
//   inbound : Message.clipboard / multi_clipboards -> Dart `clipboard` event
//   outbound: navigator.clipboard.readText() polling (no change events exist in
//             browsers) -> Message.multi_clipboards (or Clipboard for old peers)
import { create } from "@bufbuild/protobuf";
import { decompress as zstdDecompress } from "fzstd";
import {
  type Clipboard,
  ClipboardFormat,
  ClipboardSchema,
  MessageSchema,
  type Message,
  MultiClipboardsSchema,
} from "./proto/message_pb";
import { getVersionNumber } from "./version";
import { log } from "./log";

// src/clipboard.rs CLIPBOARD_INTERVAL is 333 ms for a native listener; a
// browser read is a permission-gated async call, so poll a bit slower.
const POLL_MS = 1000;

// src/clipboard.rs is_support_multi_clipboard
export function isSupportMultiClipboard(peerVersion: string, peerPlatform: string): boolean {
  const v = getVersionNumber(peerVersion);
  const p = peerPlatform.toLowerCase();
  if (p === "" || p === "ios") return false;
  if (v < getVersionNumber("1.3.0")) return false;
  if (p === "android" && v < getVersionNumber("1.3.3")) return false;
  return true;
}

// io_loop.rs (iOS arm): first Text entry, decompress if flagged, utf8.
export function textFromClipboards(cbs: Clipboard[]): string | null {
  const cb = cbs.find((c) => c.format === ClipboardFormat.Text);
  if (!cb) return null;
  let bytes: Uint8Array = cb.content;
  if (cb.compress) {
    try {
      bytes = zstdDecompress(bytes);
    } catch (e) {
      log.warn("clipboard zstd decode failed", e);
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// src/clipboard.rs plain_to_proto: compress only when smaller. The browser has
// no zstd encoder, so text goes uncompressed; the flag is per message.
export function buildClipboardMessage(text: string, peerVersion: string, peerPlatform: string): Message {
  const cb = create(ClipboardSchema, {
    compress: false,
    content: new TextEncoder().encode(text),
    format: ClipboardFormat.Text,
  });
  const m = create(MessageSchema, {});
  if (isSupportMultiClipboard(peerVersion, peerPlatform)) {
    m.union = { case: "multiClipboards", value: create(MultiClipboardsSchema, { clipboards: [cb] }) };
  } else {
    m.union = { case: "clipboard", value: cb };
  }
  return m;
}

export interface ClipboardWatcherHost {
  // Session::is_text_clipboard_required: server clipboard + keyboard
  // permission, and neither disable-clipboard nor view-only toggled.
  isRequired(): boolean;
  send(text: string): void;
}

// Polls the local clipboard while the page is focused. Permission errors pause
// polling until the next focus so the user is not spammed with prompts.
export class ClipboardWatcher {
  private timer: number | null = null;
  private lastText: string | null = null;
  private blocked = false;
  private warned = false;
  private readonly onFocus = () => {
    this.blocked = false;
    void this.poll();
  };

  constructor(private readonly host: ClipboardWatcherHost) {}

  start(): void {
    if (this.timer !== null) return;
    globalThis.addEventListener?.("focus", this.onFocus);
    this.timer = setInterval(() => void this.poll(), POLL_MS) as unknown as number;
    void this.poll();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    globalThis.removeEventListener?.("focus", this.onFocus);
  }

  // Remember what the peer sent so it is not echoed back.
  noteRemoteText(text: string): void {
    this.lastText = text;
  }

  // One-shot sync after peer info (io_loop.rs sync_init_clipboard).
  async syncNow(): Promise<void> {
    this.lastText = null;
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.blocked || !this.host.isRequired()) return;
    const doc = globalThis.document;
    if (doc && (doc.visibilityState !== "visible" || !doc.hasFocus())) return;
    const clip = globalThis.navigator?.clipboard;
    if (!clip || typeof clip.readText !== "function") return;
    let text: string;
    try {
      text = await clip.readText();
    } catch (e) {
      // NotAllowedError: permission denied or document not focused.
      this.blocked = true;
      if (!this.warned) {
        this.warned = true;
        log.warn("clipboard read not permitted; local -> remote clipboard sync paused until the page is focused again", e);
      }
      return;
    }
    if (text === "" || text === this.lastText) return;
    this.lastText = text;
    this.host.send(text);
  }
}
