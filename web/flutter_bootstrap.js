{{flutter_js}}
{{flutter_build_config}}

// No service worker: it cached rd-config.js (rendered per user by the hosting
// server) and kept serving a stale one. The app is online-only anyway.
// Fallback fonts (Roboto) are shipped next to the app under fonts/ instead of
// being fetched from fonts.gstatic.com, so the page needs no third-party host.
_flutter.loader.load({
  config: {
    fontFallbackBaseUrl: new URL("fonts/", document.baseURI).href,
  },
});
