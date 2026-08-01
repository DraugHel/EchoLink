FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-runtime

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS driver-dependencies

WORKDIR /opt/echolink/driver
COPY docker/e3-validation/driver/package.json docker/e3-validation/driver/package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm ci --ignore-scripts --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

ARG E3_SOURCE_HEAD
ARG E3_SOURCE_TREE_GIT_SHA
ARG E3_SOURCE_TREE_SHA256

LABEL org.opencontainers.image.title="EchoLink E3 Playwright Validator" \
      org.opencontainers.image.version="1" \
      echolink.e3.image-role="playwright-validator" \
      echolink.e3.runtime="node-24.18.0-playwright-1.61.1" \
      echolink.e3.source-head="$E3_SOURCE_HEAD" \
      echolink.e3.source-tree-git-sha="$E3_SOURCE_TREE_GIT_SHA" \
      echolink.e3.source-tree-sha256="$E3_SOURCE_TREE_SHA256"

COPY --from=node-runtime /usr/local /usr/local

RUN set -eux; \
    ln -sf /usr/local/bin/node /usr/bin/node; \
    mkdir -p /opt/echolink/lib /e3/empty-home; \
    chown -R 65532:65532 /e3/empty-home

COPY --from=driver-dependencies /opt/echolink/driver/node_modules /opt/echolink/node_modules
COPY --chown=65532:65532 docker/e3-validation/driver/validation-driver.mjs /opt/echolink/validation-driver.mjs
COPY --chown=65532:65532 docker/e3-validation/driver/lib /opt/echolink/lib

RUN /usr/bin/node --check /opt/echolink/validation-driver.mjs \
    && cd /opt/echolink \
    && /usr/bin/node -e "import('playwright-core').then(m => { if (!m.chromium) process.exit(1) })"

ENV NODE_ENV=test \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /opt/echolink
USER 65532:65532
