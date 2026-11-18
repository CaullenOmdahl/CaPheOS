# syntax=docker/dockerfile:1
# CaPheOS release image.
#
# One process: server/ (the HTTP face) and runtime/ (the services and the run loop). One port.
# The root filesystem is read-only; the company's data lives on a volume at /data.
# Supervision is s6-overlay as PID 1; the updater bridge is host-side (never a Docker socket here).
#
# Status: target skeleton. It builds today; it starts when `server/index.js` lands (backend P1,
# docs/BACKEND.md §8). See container/README.md.

FROM node:22-bookworm-slim AS base

ARG S6_VERSION=3.1.6.2
ARG S6_ARCH=x86_64
ARG DEBIAN_FRONTEND=noninteractive

# Certificates (providers), timezone data (the company's clock), and the supervision tree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-noarch.tar.xz /tmp/s6-noarch.tar.xz
ADD https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-${S6_ARCH}.tar.xz /tmp/s6-arch.tar.xz
RUN tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
 && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
 && rm -f /tmp/s6-*.tar.xz

# The service account. One process, dropped to this user; nothing runs as root after boot.
RUN groupadd --gid 10001 capheos \
 && useradd --uid 10001 --gid capheos --no-create-home --home-dir /app --shell /usr/sbin/nologin capheos

WORKDIR /app
COPY --chown=0:0 . /app

# s6: the CapheOS service, in the default user bundle.
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d \
 && cp -R /app/container/s6/. /etc/s6-overlay/s6-rc.d/ \
 && touch /etc/s6-overlay/s6-rc.d/user/contents.d/capheos \
 && chmod +x /etc/s6-overlay/s6-rc.d/capheos/run \
 && mkdir -p /data \
 && chown 10001:10001 /data

# Two roots, deliberately: the framework is the image (read-only), the company is /data (volume).
ENV NODE_ENV=production \
    CAPHEOS_ROOT=/app \
    CAPHEOS_DATA=/data \
    CONSOLE_HOST=0.0.0.0 \
    CONSOLE_PORT=8901 \
    HOME=/data/home \
    XDG_CACHE_HOME=/data/home/.cache \
    S6_READ_ONLY_ROOT=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2

VOLUME ["/data"]
EXPOSE 8901

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CONSOLE_PORT||8901)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/init"]
