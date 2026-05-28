# Pin to a specific upstream tag for reproducible builds.
# Update this when upgrading Cap upstream.
FROM ghcr.io/capsoftware/cap-web:v0.15.1

USER root

COPY scripts/patch-official-cap-web-r2-put.mjs /tmp/patch-official-cap-web-r2-put.mjs
RUN node /tmp/patch-official-cap-web-r2-put.mjs

USER nextjs
