ARG OPENSANDBOX_EXECD_IMAGE=docker.io/opensandbox/execd:v1.1.0
FROM ${OPENSANDBOX_EXECD_IMAGE} AS execd

FROM oven/bun:1.3.14-debian

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      make \
      gcc \
      g++ \
      nodejs \
      python3 \
      python3-pip \
      ripgrep \
      tini \
      unzip \
      util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY --from=execd /execd /usr/local/bin/execd

WORKDIR /opt/opencode-execd
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY docker/entrypoint.sh /usr/local/bin/opencode-execd-entrypoint
RUN chmod 0555 /usr/local/bin/execd /usr/local/bin/opencode-execd-entrypoint \
    && mkdir -p /workspace /tmp/opencode-sessions \
    && chmod 1777 /tmp/opencode-sessions

ENV OPENCODE_EXECD_WORKER_HOST=0.0.0.0 \
    OPENCODE_EXECD_WORKER_PORT=9010 \
    OPENCODE_EXECD_WORKER_CAPACITY=4 \
    OPENCODE_WORKSPACE_ROOT=/workspace \
    OPENCODE_SESSION_ROOT=/tmp/opencode-sessions \
    OPENSANDBOX_EXECD_URL=http://127.0.0.1:44772

EXPOSE 9010

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=6 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:9010/health');if(!r.ok)process.exit(1)"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/opencode-execd-entrypoint"]
