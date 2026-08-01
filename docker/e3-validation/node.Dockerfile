FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies

WORKDIR /opt/echolink

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/package.json client/package-lock.json ./client/
RUN npm ci --prefix client --no-audit --no-fund

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG E3_SOURCE_HEAD
ARG E3_SOURCE_TREE_GIT_SHA
ARG E3_SOURCE_TREE_SHA256

LABEL org.opencontainers.image.title="EchoLink E3 Node Validator" \
      org.opencontainers.image.version="1" \
      echolink.e3.image-role="node-validator" \
      echolink.e3.runtime="node-24.18.0" \
      echolink.e3.source-head="$E3_SOURCE_HEAD" \
      echolink.e3.source-tree-git-sha="$E3_SOURCE_TREE_GIT_SHA" \
      echolink.e3.source-tree-sha256="$E3_SOURCE_TREE_SHA256"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    ln -sf /usr/local/bin/node /usr/bin/node; \
    mkdir -p /opt/echolink/client /opt/echolink/lib /e3/empty-home; \
    chown -R 65532:65532 /e3/empty-home

COPY --from=dependencies /opt/echolink/node_modules /opt/echolink/node_modules
COPY --from=dependencies /opt/echolink/client/node_modules /opt/echolink/client/node_modules
COPY --chown=65532:65532 docker/e3-validation/driver/validation-driver.mjs /opt/echolink/validation-driver.mjs
COPY --chown=65532:65532 docker/e3-validation/driver/lib /opt/echolink/lib

RUN /usr/bin/node --check /opt/echolink/validation-driver.mjs

ENV NODE_ENV=test
WORKDIR /opt/echolink
USER 65532:65532
