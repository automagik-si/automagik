# syntax=docker/dockerfile:1
# The Automagik server image: the automagik-web dsh profile (dsh-base + dsh-web-app, the Bot
# team, the welcome and ACP) on a pinned DeepSeek Harness, ready for /data on a host. Built by
# CI only (.github/workflows/server-image.yml), which extracts the rootfs, scans it
# (server/secrecy.mjs) and only then publishes it to ghcr.io/automagik-si/automagik-server.
#
# Build from the repository root (the builder reuses the desktop's pinned runtime lock):
#   docker build -f server/Dockerfile -t automagik-server .
#
# The runtime is the distroless nodejs24 rootfs (node and glibc), cleaned in the tools stage
# (no man pages or changelogs), plus the image's code and the tools Bots need in their shell
# (bash, dash as /bin/sh, git core, ripgrep, tar, gzip and find for Omni's installer), am from
# the content release's pinned tarball, and herdr-core/hc from its pinned release. No npm, apt,
# curl or build toolchain in the final image. The release pins are build args; every plugin
# tarball is checked against the release's plugins.json (sha512 integrity, size) and
# PLUGINS.SHA256SUMS (sha256) before dsh installs it (server/fetch-plugins.mjs), and am is
# checked against its own release .sha256 (server/fetch-am.mjs). The vendor CLIs (Claude Code,
# Codex) are never baked in: the first boot installs them into the data volume through the
# shipped CLI store, with AUTOMAGIK_PNPM pointing at /usr/local/bin/pnpm.

FROM gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b AS base

FROM node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0 AS builder

ARG AUTOMAGIK_VERSION=3.90.1
ARG DSH_VERSION=0.2.2-rc.2
ARG IMAGE_REVISION=unknown
ARG AUTOMAGIK_REPOSITORY=https://github.com/automagik-si/automagik
ARG INPUT_KIND=release
ARG INPUT_EVENT=
ARG INPUT_MANIFEST=

ENV DO_NOT_TRACK=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /build
# The desktop's own runtime pins (dsh 0.2.2-rc.2, pnpm 10.34.6, zod 4.6.6), the pruner the
# desktop build uses, and the runtime patches the desktop carries (assemble applies them to the
# same pinned packages). The same pins keep this image on the harness the plugins are tested on.
COPY apps/desktop/runtime/package.json apps/desktop/runtime/package-lock.json /build/apps/desktop/runtime/
COPY apps/desktop/runtime/patches /build/apps/desktop/runtime/patches
COPY apps/desktop/scripts/prune-runtime.mjs apps/desktop/scripts/runtime-patches.mjs /build/apps/desktop/scripts/
COPY apps/desktop/src/profile-patch.mjs /build/apps/desktop/src/
COPY server /build/server

RUN node /build/server/assemble.mjs \
      --out /build/out \
      --version "$AUTOMAGIK_VERSION" \
      --dsh "$DSH_VERSION" \
      --revision "$IMAGE_REVISION" \
      --repository "$AUTOMAGIK_REPOSITORY" \
      --input-kind "$INPUT_KIND" --event "$INPUT_EVENT" --input-manifest "$INPUT_MANIFEST"

# One admission point for every pnpm entry the image ships (runtime, profile and .bin paths):
# the real pnpm.cjs is renamed beside each wrapper, and the wrapper shares one lock.
RUN node /build/server/install-pnpm-admission.mjs /build/out

# The shell tools Bots need, prepared for the distroless base: the binaries, the shared-library
# closure ldd names for them, and the /data ownership. Git core only: perl-based git
# subcommands are not shipped. Debian 12 here matches
# the distroless nodejs24-debian12 base.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS tools

# herdr-core's supported Linux release, pinned by the sha256 its manifest names. The build
# runs it here, on the same glibc family as the distroless base, before copying the binary.
ARG HERDR_CORE_VERSION=0.1.18
ARG HERDR_CORE_SHA256=5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7
# The app must not be PID 1: ownership records reject pid <= 1. Tini is the container's init.
ARG TINI_VERSION=0.19.0
ARG TINI_SHA256=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee
ARG TINI_LICENSE_SHA256=e5f46bca81266bdd511cf08018d66866870531794569c04f9b45f50dd23c28b0

# The distroless rootfs, stripped here where coreutils exist, before it is copied into the final
# image. No man pages or changelogs (nothing reads them, and their .gz files are archives the
# secrecy scan refuses); the shell and libraries Bots need stay.
COPY --from=base / /out/rootfs

# `binutils` is build-only (this stage never reaches the runtime image): it strips the distroless
# Node binary, which ships with its DWARF and static symbol sections (17.8 MB of the 122.5 MB
# file). Nothing in the image reads them, and --strip-all keeps the dynamic symbol table, so
# modules load and JS stack traces are unchanged (C++ symbol names in a native trace are gone).
# The binary is the only unstripped ELF in the base.
RUN set -eux; \
    rm -rf /out/rootfs/usr/share/doc /out/rootfs/usr/share/man /out/rootfs/usr/share/info /out/rootfs/usr/share/lintian; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash dash git ripgrep ca-certificates util-linux tar gzip findutils binutils curl; \
    rm -rf /var/lib/apt/lists/*; \
    node_before="$(stat -c %s /out/rootfs/nodejs/bin/node)"; \
    chmod u+w /out/rootfs/nodejs/bin/node; \
    strip --strip-all /out/rootfs/nodejs/bin/node; \
    chmod 0555 /out/rootfs/nodejs/bin/node; \
    echo "node: stripped ${node_before} -> $(stat -c %s /out/rootfs/nodejs/bin/node) bytes"; \
    mkdir -p /out/bin /out/lib /out/data/dsh /out/data/bots /out/data/workspace /out/data/secrets; \
    for f in /bin/bash /bin/dash /usr/bin/env /usr/bin/printenv /usr/bin/git /usr/bin/rg /usr/bin/flock /bin/tar /bin/gzip /usr/bin/find /usr/lib/git-core/*; do ldd "$f" 2>/dev/null || true; done \
      | awk '/=>/ {print $3}' | sort -u > /tmp/libs; \
    while read -r lib; do \
      case "$lib" in \
        */libc.so.6|*/libm.so.6|*/libpthread.so.0|*/libdl.so.2|*/librt.so.1|*/libstdc++.so.6|*/libgcc_s.so.1|*/ld-linux*) continue;; \
      esac; \
      cp -L "$lib" /out/lib/; \
    done < /tmp/libs; \
    cp /bin/bash /bin/dash /usr/bin/env /usr/bin/printenv /usr/bin/git /usr/bin/rg /usr/bin/flock /bin/tar /bin/gzip /usr/bin/find /out/bin/; \
    ln -s /bin/dash /out/bin/sh; \
    cp -a /usr/lib/git-core /out/git-core; \
    cp -a /usr/share/git-core /out/git-core-share; \
    cp -a /etc/ssl/certs /out/certs; \
    mkdir -p /out/licenses/herdr-core /out/licenses/tini; \
    curl -fsSL --proto '=https' -o /tmp/tini-static "https://github.com/krallin/tini/releases/download/v${TINI_VERSION}/tini-static"; \
    echo "${TINI_SHA256}  /tmp/tini-static" | sha256sum -c -; \
    install -m 0755 /tmp/tini-static /out/bin/tini; \
    rm -f /tmp/tini-static; \
    curl -fsSL --proto '=https' -o /out/licenses/tini/LICENSE \
      "https://raw.githubusercontent.com/krallin/tini/v${TINI_VERSION}/LICENSE"; \
    echo "${TINI_LICENSE_SHA256}  /out/licenses/tini/LICENSE" | sha256sum -c -; \
    curl -fsSL --proto '=https' -o /tmp/herdr-core.tar.gz "https://releases.herdr.dev/core/${HERDR_CORE_VERSION}/herdr-core-linux-x86_64.tar.gz"; \
    echo "${HERDR_CORE_SHA256}  /tmp/herdr-core.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/herdr-core.tar.gz -C /tmp herdr-core LICENSE THIRD-PARTY-NOTICES; \
    install -m 0755 /tmp/herdr-core /out/bin/herdr-core; \
    ln -s herdr-core /out/bin/hc; \
    mv /tmp/LICENSE /tmp/THIRD-PARTY-NOTICES /out/licenses/herdr-core/; \
    rm -f /tmp/herdr-core.tar.gz /tmp/herdr-core; \
    /out/bin/hc --version | grep -qx "hc ${HERDR_CORE_VERSION}"; \
    install -d -o 1000 -g 1000 -m 0700 /out/rootfs/run/automagik; \
    chmod 0700 /out/data/secrets; \
    chown -R 1000:1000 /out/data

# Exact WebAuthn library and transitive lock, installed with the repository's Bun version.
# Bun is a builder only; the gate and its dependencies run on the image's Node 24.
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS gate-deps
WORKDIR /gate
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --linker hoisted
COPY apps/desktop/scripts/prune-runtime.mjs /gate/prune-runtime.mjs
RUN bun --eval 'import { pruneNodeModules } from "./prune-runtime.mjs"; pruneNodeModules("./node_modules")'

FROM scratch AS runtime

# The image's content version (the release whose plugin tarballs it installs, which may not be
# the repository's) and the commit that built it name the image: the tag is
# <content>-<short revision>, :latest compares the version label, and the revision is the full
# workflow commit. `AUTOMAGIK_VERSION` in the builder is that plugin release.
ARG IMAGE_VERSION=3.90.1
ARG IMAGE_REVISION=unknown
ARG INPUT_KIND=release
ARG INPUT_MANIFEST=

LABEL org.opencontainers.image.title="Automagik server" \
      org.opencontainers.image.description="The automagik-web DeepSeek Harness profile for a host: the Bot team, the welcome and ACP agents" \
      org.opencontainers.image.source="https://github.com/automagik-si/automagik" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      ai.automagik.input.kind="${INPUT_KIND}" \
      ai.automagik.input.manifest="${INPUT_MANIFEST}"

# The cleaned distroless rootfs (node, glibc and its account records) and the tools Bots need.
COPY --from=tools /out/rootfs/ /
COPY --from=tools /out/lib/ /usr/lib/x86_64-linux-gnu/
COPY --from=tools /out/bin/bash /bin/bash
COPY --from=tools /out/bin/dash /bin/dash
COPY --from=tools /out/bin/sh /bin/sh
COPY --from=tools /out/bin/env /usr/bin/env
COPY --from=tools /out/bin/printenv /usr/bin/printenv
COPY --from=tools /out/bin/git /usr/bin/git
COPY --from=tools /out/bin/rg /usr/bin/rg
COPY --from=tools /out/bin/flock /usr/bin/flock
COPY --from=tools /out/bin/tar /usr/bin/tar
COPY --from=tools /out/bin/gzip /usr/bin/gzip
COPY --from=tools /out/bin/find /usr/bin/find
COPY --from=tools /out/git-core /usr/lib/git-core
COPY --from=tools /out/git-core-share /usr/share/git-core
COPY --from=tools /out/certs /etc/ssl/certs
COPY --from=tools /out/bin/tini /usr/local/bin/tini
COPY --from=tools /out/bin/herdr-core /usr/local/bin/herdr-core
COPY --from=tools /out/bin/hc /usr/local/bin/hc
COPY --from=tools /out/licenses /opt/automagik/licenses
COPY --from=tools --chown=1000:1000 /out/data /data

COPY --from=gate-deps /gate/node_modules /opt/automagik/node_modules
COPY --from=builder /build/out/runtime /opt/automagik/runtime
COPY --from=builder /build/out/profile /opt/automagik/profile
COPY --from=builder /build/out/versions.json /opt/automagik/versions.json
COPY --from=builder /build/out/pnpm-admission.json /opt/automagik/pnpm-admission.json
COPY --from=builder /build/out/offline-store /opt/automagik/offline-store
COPY --from=builder /build/out/am /opt/automagik/am
COPY server/entrypoint.mjs server/native-worker-login.mjs server/healthcheck.mjs server/lib.mjs \
     server/gate*.mjs server/profile-*.mjs server/plugin-payload.mjs server/volume-lock.mjs \
     server/first-boot.mjs server/cli-store.mjs server/in-image-smoke.mjs server/toolchain.mjs \
     /opt/automagik/
COPY apps/desktop/src/profile-patch.mjs /opt/apps/desktop/src/
# No /home/<user> in the image's account record: the distroless nonroot home is replaced with
# the uid the image actually runs as. The scanner's home check then has nothing to excuse.
COPY server/passwd /etc/passwd
COPY --chmod=0755 server/bin/dsh server/bin/pnpm server/bin/pnpm-admission server/bin/am /usr/local/bin/

ENV AUTOMAGIK_GATE_IMAGE=1 \
    HOME=/data \
    DSH_HOME=/data/dsh \
    AUTOMAGIK_BOTS_HOME=/data/bots \
    AUTOMAGIK_HOME=/data \
    AUTOMAGIK_WORKSPACE=/data/workspace \
    AUTOMAGIK_PNPM=/usr/local/bin/pnpm \
    HERDR_APP_HOME=/data/herdr-app \
    XDG_RUNTIME_DIR=/run/automagik \
    HC_RUNTIME=/run/automagik/herdr-core \
    HC_SESSION=automagik-server \
    NODE_ENV=production \
    DO_NOT_TRACK=1 \
    PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin

# Distroless has no useradd: the uid/gid are numeric, and /data is already theirs.
USER 1000:1000
# Kept off /data on purpose; see the Incus section in README.md.
WORKDIR /opt/automagik

# 401 is the healthy answer without a browser session: the auth fence is up. The script prints
# the code to the container's health log; it uses node, not curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["/nodejs/bin/node", "/opt/automagik/healthcheck.mjs"]

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/tini", "--", "/nodejs/bin/node", "/opt/automagik/entrypoint.mjs"]
CMD []
