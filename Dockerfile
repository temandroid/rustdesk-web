# rustdesk-web-core: static web client image (Flutter shell + open TS core).
#
#   docker build -t rustdesk-web-core .
#   docker build --build-arg RUSTDESK_REF=<commit or tag> -t rustdesk-web-core .
#
# Stage 1 builds the TypeScript core against a RustDesk source checkout (it
# needs message.proto and the English strings from that tree), stage 2 builds
# the Flutter web shell with the two small patches from patches/, stage 3 is
# nginx serving the result. Runtime configuration comes from environment
# variables rendered into /rd-config.js by docker/10-rd-config.sh.

ARG RUSTDESK_REPO=https://github.com/rustdesk/rustdesk.git
# Keep in sync with RUSTDESK_REF (the shell this core was written against).
ARG RUSTDESK_REF=851d2df88cc8ef7a8368f74e8b2e7254861ee00a
ARG FLUTTER_VERSION=3.24.5

# ---------------------------------------------------------------- core ----
FROM node:22-bookworm-slim AS core
ARG RUSTDESK_REPO
ARG RUSTDESK_REF
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Shallow clone of the pinned ref; no submodules (rendezvous.proto is vendored here).
RUN git clone --depth 1 --branch "${RUSTDESK_REF}" "${RUSTDESK_REPO}" rustdesk \
 || (git clone --depth 1 "${RUSTDESK_REPO}" rustdesk && cd rustdesk && git fetch --depth 1 origin "${RUSTDESK_REF}" && git checkout FETCH_HEAD)
COPY package.json package-lock.json buf.gen.yaml tsconfig.json vite.config.ts /src/web-core/
COPY proto /src/web-core/proto
COPY scripts /src/web-core/scripts
COPY src /src/web-core/src
COPY tools/rdev /src/web-core/tools/rdev
COPY web /src/web-core/web
COPY patches /src/web-core/patches
WORKDIR /src/web-core
RUN npm ci
ENV RUSTDESK_SRC=/src/rustdesk
RUN npm run build && node scripts/sync-to-flutter.mjs
# Shell patches (toolbar entry on web, file-manager back action)
WORKDIR /src/rustdesk
RUN git apply --verbose /src/web-core/patches/rustdesk-web-shell.patch

# --------------------------------------------------------------- shell ----
FROM ghcr.io/cirruslabs/flutter:${FLUTTER_VERSION} AS shell
COPY --from=core /src/rustdesk /src/rustdesk
WORKDIR /src/rustdesk/flutter
RUN flutter config --no-analytics >/dev/null 2>&1 || true \
 && flutter pub get \
 && flutter build web --release --web-renderer canvaskit --no-web-resources-cdn --base-href /

# --------------------------------------------------------------- serve ----
FROM nginx:1.27-alpine
LABEL org.opencontainers.image.source="https://github.com/quietlydismantled/rustdesk-web-core"
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/10-rd-config.sh /docker-entrypoint.d/10-rd-config.sh
RUN chmod +x /docker-entrypoint.d/10-rd-config.sh
COPY --from=shell /src/rustdesk/flutter/build/web /usr/share/nginx/html
EXPOSE 80
