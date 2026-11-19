# syntax=docker/dockerfile:1
# The Automagik Linux image (RFC 0016, "The image"; wslc/README.md). Built in CI only
# (.github/workflows/linux-image.yml), never on a person's machine, and not published yet.
#
# Build context: apps/desktop, after `node scripts/prepare-runtime.mjs` there has made build/runtime
# (the pinned DeepSeek Harness and the pnpm 10 it installs plugins with) and build/profile (the
# profile the desktop ships). Run that on Linux x86_64 with Node 24: the runtime's native modules
# are built for the machine and the Node they are installed on. The base is Debian 13 (trixie),
# whose glibc (2.41) is no older than the CI runner's (Ubuntu 24.04, 2.39), so they load here.
#   docker build -f wslc/Dockerfile -t automagik-linux .
#
# Inside: Node 24 (DSH needs 22.19 or later), git, bash, coreutils, openssh-client, ripgrep,
# bubblewrap, ca-certificates, curl, procps, tini, herdr-core's `hc`, the runtime and the profile,
# and the launcher at /opt/automagik/bin/dsh-launch. The guest user is automagik (uid 1000); its
# home, /home/automagik, is the volume WSLC mounts (the person's data; a new image never touches
# it). DSH listens on 41700. /mnt/automagik-exchange (downloads/, lane/) is where the one Windows
# folder is mounted.

# Node 24.22.2 on Debian trixie slim, by digest.
FROM node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

ARG AUTOMAGIK_VERSION=0.0.0
# herdr-core's release, pinned to the sha256 its release manifest names
# (https://releases.herdr.dev/core/latest.json at 0.1.18).
ARG HC_VERSION=0.1.18
ARG HC_SHA256=5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7

LABEL org.opencontainers.image.title="Automagik Linux image" \
      org.opencontainers.image.description="DSH, its tools and the guest launcher, for the Automagik desktop app on WSLC (RFC 0016)" \
      org.opencontainers.image.source="https://github.com/automagik-si/automagik" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${AUTOMAGIK_VERSION}"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eux; \
    [ "$(dpkg --print-architecture)" = amd64 ] || { echo "only x86_64 is built" >&2; exit 1; }; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash bubblewrap ca-certificates coreutils curl git openssh-client procps ripgrep tini; \
    rm -rf /var/lib/apt/lists/*

# hc: herdr-core's Linux build, checked against its sha256 before it is unpacked.
RUN set -eux; \
    cd /tmp; \
    curl -fsSL --proto '=https' -o hc.tar.gz "https://releases.herdr.dev/core/${HC_VERSION}/herdr-core-linux-x86_64.tar.gz"; \
    echo "${HC_SHA256}  hc.tar.gz" | sha256sum -c -; \
    tar -xzf hc.tar.gz herdr-core LICENSE THIRD-PARTY-NOTICES; \
    install -m 0755 herdr-core /usr/local/bin/herdr-core; \
    ln -s herdr-core /usr/local/bin/hc; \
    install -d /usr/local/share/doc/herdr-core; \
    mv LICENSE THIRD-PARTY-NOTICES /usr/local/share/doc/herdr-core/; \
    rm -f hc.tar.gz herdr-core; \
    hc --version

# The guest user takes uid 1000 from the base image's `node`.
RUN set -eux; \
    userdel --remove node; \
    groupadd --gid 1000 automagik; \
    useradd --uid 1000 --gid 1000 --create-home --home-dir /home/automagik --shell /bin/bash automagik; \
    install -d -o automagik -g automagik -m 0755 /mnt/automagik-exchange /mnt/automagik-exchange/downloads /mnt/automagik-exchange/lane

# The DeepSeek Harness and the profile the desktop ships, read-only code, and the launcher that
# binds dsh's plugin operations to the runtime's pnpm by absolute path.
COPY build/runtime /opt/automagik/runtime
COPY build/profile /opt/automagik/profile
COPY build/versions.json /opt/automagik/versions.json
COPY build/dsh-launch /opt/automagik/dsh-launch
# The launcher, and the desktop's own modules it starts DSH and runs the lane with.
COPY package.json /opt/automagik/desktop/package.json
COPY build/runtime/node_modules/yaml /opt/automagik/desktop/node_modules/yaml
COPY src/dsh.js src/profile-patch.mjs src/child-paths.js src/close-inherited.cjs src/close-inherited-preload.cjs \
     src/lane.js src/lane-keys.js src/privacy.js src/tar.js src/update.js /opt/automagik/desktop/src/
COPY wslc/bin /opt/automagik/desktop/wslc/bin
COPY wslc/lib /opt/automagik/desktop/wslc/lib

RUN set -eux; \
    install -d /opt/automagik/bin; \
    chmod 0755 /opt/automagik/desktop/wslc/bin/*.mjs; \
    ln -s ../desktop/wslc/bin/dsh-launch.mjs /opt/automagik/bin/dsh-launch; \
    ln -s ../desktop/wslc/bin/xdg-open.mjs /opt/automagik/bin/xdg-open; \
    printf '#!/bin/sh\n# The pnpm other tools find on PATH (the desktop runtime'"'"'s pinned pnpm 10); plugin operations run it by absolute path through dsh-launch.\nexec node /opt/automagik/runtime/node_modules/pnpm/bin/pnpm.cjs "$@"\n' > /usr/local/bin/pnpm; \
    chmod 0755 /usr/local/bin/pnpm; \
    pnpm --version; \
    node --version

ENV PATH=/opt/automagik/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BROWSER=/opt/automagik/bin/xdg-open \
    HOME=/home/automagik

USER automagik
WORKDIR /home/automagik
EXPOSE 41700

# The container is long-lived and idles; the app runs dsh-launch in it with piped stdio.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
