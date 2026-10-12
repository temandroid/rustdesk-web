{{flutter_js}}
{{flutter_build_config}}

// Fallback fonts (Roboto) are shipped next to the app under fonts/ instead of
// being fetched from fonts.gstatic.com, so the page needs no third-party host.
_flutter.loader.load({
  serviceWorkerSettings: {
    serviceWorkerVersion: {{flutter_service_worker_version}},
  },
  config: {
    fontFallbackBaseUrl: new URL("fonts/", document.baseURI).href,
  },
});
