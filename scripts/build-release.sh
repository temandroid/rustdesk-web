#!/usr/bin/env bash
# Builds the static web client into dist-web/ and packs rustdesk-web.tar.gz.
#
#   BASE_HREF   where the client is served from (default /web/)
#   SOURCE_URL  link shown on the page for AGPL-3.0 section 13
#               (default: this repository at the current commit)
# Needs node 22, git and flutter (version in .github/workflows/release.yml) on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BASE_HREF=${BASE_HREF:-/web/}
REF=$(tr -d '[:space:]' < RUSTDESK_REF)
COMMIT=$(git rev-parse HEAD)
if [ -z "${SOURCE_URL:-}" ] && ! git diff --quiet HEAD --; then
  # The page must link to the exact source it was built from (AGPL-3.0 s.13)
  echo "uncommitted changes: commit them or set SOURCE_URL explicitly" >&2
  exit 1
fi
SOURCE_URL=${SOURCE_URL:-https://github.com/temandroid/rustdesk-web/tree/$COMMIT}
case "$SOURCE_URL" in
  https://*) ;;
  *) echo "SOURCE_URL must be an https URL" >&2; exit 1 ;;
esac
if printf '%s' "$SOURCE_URL" | grep -q '["<>[:space:]]'; then
  echo "SOURCE_URL contains characters not allowed in an HTML attribute" >&2
  exit 1
fi
WORK=${WORK:-$ROOT/.build}

mkdir -p "$WORK"
if [ ! -d "$WORK/rustdesk/.git" ]; then
  git init -q "$WORK/rustdesk"
  git -C "$WORK/rustdesk" remote add origin https://github.com/rustdesk/rustdesk.git
fi
git -C "$WORK/rustdesk" fetch -q --depth 1 origin "$REF"
git -C "$WORK/rustdesk" checkout -q --force FETCH_HEAD
git -C "$WORK/rustdesk" clean -qfdx flutter

npm ci --no-audit --no-fund
RUSTDESK_SRC="$WORK/rustdesk" npm run build
npm test
RUSTDESK_SRC="$WORK/rustdesk" node scripts/sync-to-flutter.mjs
git -C "$WORK/rustdesk" apply "$ROOT/patches/rustdesk-web-shell.patch"

cd "$WORK/rustdesk/flutter"
flutter config --no-analytics >/dev/null 2>&1 || true
flutter pub get
flutter build web --release --web-renderer canvaskit --no-web-resources-cdn --base-href "$BASE_HREF"

rm -rf "$ROOT/dist-web"
cp -r build/web "$ROOT/dist-web"
cd "$ROOT/dist-web"
# Literal replacement: '&', '#' or '\' in the URL must not act as sed syntax
SOURCE_URL="$SOURCE_URL" node -e '
  const fs = require("fs");
  const html = fs.readFileSync("index.html", "utf8");
  fs.writeFileSync("index.html", html.split("__RD_SOURCE_URL__").join(process.env.SOURCE_URL.replace(/&/g, "&amp;")));
'
if grep -q "__RD_SOURCE_URL__" index.html || ! grep -q "id=\"rd-source\" href=\"https://" index.html; then echo "source link missing in index.html" >&2; exit 1; fi
# Deployments render their own rd-config.js; ship an empty default.
printf '// Rendered by the hosting server.\nwindow.RD_CONFIG = window.RD_CONFIG || {};\n' > rd-config.js
cp "$ROOT/LICENSE" "$ROOT/NOTICE" .
# Roboto (Apache-2.0) at the path the Flutter engine asks for under
# fontFallbackBaseUrl (see web/flutter_bootstrap.js).
ROBOTO=roboto/v20/KFOmCnqEu92Fr1Me5WZLCzYlKw.ttf
ROBOTO_SHA256=017c0be9aaa6d0359737e1fa762ad304c0e0107927faff5a6c1f415c7f5244ed
grep -q "$ROBOTO" main.dart.js || { echo "engine no longer asks for $ROBOTO; update the font" >&2; exit 1; }
mkdir -p "fonts/$(dirname "$ROBOTO")"
curl -fsSL -o "fonts/$ROBOTO" "https://fonts.gstatic.com/s/$ROBOTO"
echo "$ROBOTO_SHA256  fonts/$ROBOTO" | sha256sum -c -
cp "$ROOT/fonts/ROBOTO-LICENSE.txt" fonts/
# Roboto Mono (SIL OFL 1.1) for the terminal, at the path
# lib/web/terminal_font.dart loads when window.rustdeskLocalFonts is set.
ROBOTO_MONO_URL=https://raw.githubusercontent.com/googlefonts/RobotoMono/895ec691990d041dd727c7b5afa3ce56525d98e6/fonts/ttf/RobotoMono-Regular.ttf
ROBOTO_MONO_SHA256=af0bff7599c3df3831755c16e39b3c496df74b8c8d8a1161b14dc8461be17cb4
curl -fsSL -o fonts/RobotoMono-Regular.ttf "$ROBOTO_MONO_URL"
echo "$ROBOTO_MONO_SHA256  fonts/RobotoMono-Regular.ttf" | sha256sum -c -
cp "$ROOT/fonts/ROBOTO-MONO-OFL.txt" fonts/
printf '{"commit":"%s","rustdesk":"%s","baseHref":"%s"}\n' "$COMMIT" "$REF" "$BASE_HREF" > build-info.json
tar -czf "$ROOT/rustdesk-web.tar.gz" .
cd "$ROOT"
sha256sum rustdesk-web.tar.gz | tee rustdesk-web.tar.gz.sha256
