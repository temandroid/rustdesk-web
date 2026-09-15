// Multiple concurrent sessions for a web shell that never passes session ids.
//
// The Dart web shell keeps one page per session (remote view, file manager)
// and binds its callbacks by assigning window.onGlobalEvent / onVideoFrame /
// onRgba when the page mounts. A file-transfer page pushed on top of a live
// remote page overwrites those globals. This manager intercepts the
// assignments with accessor properties, attributes each one to the session
// whose page is on top, and dispatches every session's events through the
// callbacks it captured, so a hidden page keeps receiving its own events and
// gets them back untouched after the page above it pops.
import { ConnType } from "./proto/rendezvous_pb";
import type { Session, Fields } from "./session";
import { log } from "./log";

type AnyFn = (...args: never[]) => unknown;
const NAMES = ["onGlobalEvent", "onVideoFrame", "onRgba"] as const;
type CbName = (typeof NAMES)[number];
type Snapshot = Record<CbName, AnyFn | null>;

export class SessionSlot {
  readonly snapshot: Snapshot = { onGlobalEvent: null, onVideoFrame: null, onRgba: null };
  // Set when another page was pushed over this one and then popped: the
  // shell's shared WebVideoFrameQueue has ended that page's session, so the
  // zero-copy path is dead for it and frames must go through onRgba.
  preferRgba = false;
  session!: Session;
  constructor(readonly connType: ConnType, readonly peerId: string) {}
}

export class SessionManager {
  private slots: SessionSlot[] = [];
  private current: Snapshot = { onGlobalEvent: null, onVideoFrame: null, onRgba: null };
  private hooked = false;

  // Must run before Flutter starts so the shell's assignments hit the setters.
  installHooks(): void {
    if (this.hooked) return;
    this.hooked = true;
    const g = globalThis as unknown as Record<string, unknown>;
    for (const name of NAMES) {
      const existing = typeof g[name] === "function" ? (g[name] as AnyFn) : null;
      this.current[name] = existing;
      try {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: true,
          get: () => this.current[name],
          set: (v: unknown) => {
            const fn = typeof v === "function" ? (v as AnyFn) : null;
            this.current[name] = fn;
            const top = this.top();
            if (top) top.snapshot[name] = fn;
          },
        });
      } catch (e) {
        log.error(`cannot hook window.${name}`, e);
      }
    }
  }

  top(): SessionSlot | null {
    return this.slots.length ? this.slots[this.slots.length - 1]! : null;
  }

  byType(t: ConnType): SessionSlot | null {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]!;
      if (s.connType === t) return s;
    }
    return null;
  }

  all(): SessionSlot[] {
    return [...this.slots];
  }

  // Seeds the snapshot with whatever the shell has bound right now; the page
  // that owns the new session rebinds right after `session_start`.
  add(connType: ConnType, peerId: string): SessionSlot {
    const slot = new SessionSlot(connType, peerId);
    slot.snapshot.onGlobalEvent = this.current.onGlobalEvent;
    slot.snapshot.onVideoFrame = this.current.onVideoFrame;
    slot.snapshot.onRgba = this.current.onRgba;
    this.slots.push(slot);
    return slot;
  }

  remove(slot: SessionSlot): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    const wasTop = i === this.slots.length - 1;
    this.slots.splice(i, 1);
    const top = this.top();
    if (wasTop && top && top.connType === ConnType.DEFAULT_CONN && !top.preferRgba) {
      top.preferRgba = true;
      log.info("nested session closed; remote session continues on the RGBA path");
    }
  }

  emit(slot: SessionSlot, name: string, fields: Fields): void {
    const fn = slot.snapshot.onGlobalEvent as ((json: string) => void) | null;
    if (typeof fn !== "function") return;
    try {
      fn(JSON.stringify({ ...fields, name }));
    } catch (e) {
      log.error("onGlobalEvent threw", e);
    }
  }

  videoFrame(slot: SessionSlot, display: number, frame: VideoFrame): boolean {
    if (slot.preferRgba || slot !== this.top()) return false;
    const fn = slot.snapshot.onVideoFrame as ((d: number, f: VideoFrame) => void) | null;
    if (typeof fn !== "function") return false;
    try {
      fn(display, frame);
      return true;
    } catch (e) {
      log.error("onVideoFrame threw", e);
      return false;
    }
  }

  rgba(slot: SessionSlot, display: number, rgba: Uint8Array): boolean {
    if (slot !== this.top()) return false;
    const fn = slot.snapshot.onRgba as ((d: number, r: Uint8Array) => void) | null;
    if (typeof fn !== "function") return false;
    try {
      fn(display, rgba);
      return true;
    } catch (e) {
      log.error("onRgba threw", e);
      return false;
    }
  }
}

export const sessions = new SessionManager();
