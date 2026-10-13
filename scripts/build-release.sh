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
SOURCE_URL=${SOURCE_URL:-https://github.com/temandroid/rustdesk-web/tree/$COMMIT}
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
sed -i "s#__RD_SOURCE_URL__#${SOURCE_URL}#" index.html
grep -q "$COMMIT" index.html || { echo "source link missing in index.html" >&2; exit 1; }
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
