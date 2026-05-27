FROM ghcr.io/capsoftware/cap-web:latest

USER root

COPY scripts/patch-official-cap-web-r2-put.mjs /tmp/patch-official-cap-web-r2-put.mjs
RUN node /tmp/patch-official-cap-web-r2-put.mjs

USER nextjs
