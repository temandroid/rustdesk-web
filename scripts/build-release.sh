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
printf '{"commit":"%s","rustdesk":"%s","baseHref":"%s"}\n' "$COMMIT" "$REF" "$BASE_HREF" > build-info.json
tar -czf "$ROOT/rustdesk-web.tar.gz" .
cd "$ROOT"
sha256sum rustdesk-web.tar.gz | tee rustdesk-web.tar.gz.sha256
