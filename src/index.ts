// Entry point. Installs the globals the Flutter web shell expects
// (flutter/lib/web/common.dart evaluates isMobile()/getByName at import time,
// web_model.dart calls init() and waits for onInitFinished()).
import { getByName, refreshCodecProbe, setByName } from "./bridge";
import { initCrypto } from "./crypto";
import { applyRuntimeConfig } from "./config";
import { log } from "./log";
import { VERSION } from "./version";
import { sessions } from "./sessions";
import { WebRtcStream, buildIceServers, fingerprintFromSdp } from "./transport/webrtc";

interface Globals {
  init?: () => void;
  isMobile?: () => boolean;
  setByName?: (name: string, arg?: unknown) => unknown;
  getByName?: (name: string, arg?: unknown) => string;
  onInitFinished?: () => void;
  rdCore?: { version: string; ready: boolean; webrtc?: unknown };
}

const g = globalThis as unknown as Globals;

// Capture the shell's callback assignments before Flutter boots.
sessions.installHooks();


let ready = false;
const pending: Array<[string, unknown]> = [];

g.isMobile = () =>
  /android|iphone|ipad|ipod|mobile|blackberry|iemobile|opera mini/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent) && !/Windows/.test(navigator.userAgent) && false);

g.setByName = (name: string, arg?: unknown) => {
  if (!ready) {
    // Config writes are safe before init; session calls wait for sodium.
    if (name.startsWith("option") || name === "envvar") return setByName(name, arg);
    pending.push([name, arg]);
    return "";
  }
  return setByName(name, arg);
};

g.getByName = (name: string, arg?: unknown) => getByName(name, arg ?? "");

g.init = () => {
  void (async () => {
    try {
      applyRuntimeConfig();
      await initCrypto();
      await refreshCodecProbe();
      ready = true;
      g.rdCore = { version: VERSION, ready: true, webrtc: { WebRtcStream, buildIceServers, fingerprintFromSdp } };
      for (const [n, a] of pending.splice(0)) setByName(n, a);
      log.info(`rustdesk web core ${VERSION} ready`);
    } catch (e) {
      log.error("init failed", e);
    } finally {
      try {
        g.onInitFinished?.();
      } catch (e) {
        log.error("onInitFinished threw", e);
      }
    }
  })();
};

// web_model.dart setFullscreenCallback: Dart installs window.onFullscreenChanged(bool)
// and keeps its toolbar/tab-bar state in sync with the browser.
globalThis.document?.addEventListener("fullscreenchange", () => {
  const fn = (globalThis as unknown as { onFullscreenChanged?: (v: boolean) => void }).onFullscreenChanged;
  if (typeof fn === "function") {
    try {
      fn(!!document.fullscreenElement);
    } catch (e) {
      log.error("onFullscreenChanged threw", e);
    }
  }
});

g.rdCore = { version: VERSION, ready: false, webrtc: { WebRtcStream, buildIceServers, fingerprintFromSdp } };
