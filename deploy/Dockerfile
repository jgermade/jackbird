# jackbird's service in a container (F5, RECORD/2026-08-11.musikmatch-rust-migration.WIP.md,
# 2026-11-09 17:10): Alpine, CA certificates (SMTP over TLS), and the release's static binary of
# its architecture, which carries the web build. Built per architecture from
# `bin/jackbird-service-linux-<amd64|arm64>` (ship.yml puts them there) and joined into one image.
#
#   docker build --platform linux/amd64 -f deploy/Dockerfile -t jackbird deploy
FROM alpine:3.20

ARG TARGETARCH
RUN apk add --no-cache ca-certificates \
 && adduser -D -h /home/jackbird -u 1000 jackbird \
 && mkdir -p /config /library \
 && chown jackbird:jackbird /config /library
COPY --chmod=0755 bin/jackbird-service-linux-${TARGETARCH} /usr/local/bin/jackbird-service

# Its configuration, people and console key in /config; the family library in /library. Music to
# import is mounted under the home folder, where the folder dialog starts. It listens on every
# address of the container; open (sign-in off), it answers only the host: the container's default
# gateway (the port should be published on the host's loopback, as deploy/compose.yaml does).
ENV HOME=/home/jackbird \
    JACKBIRD_SERVICE_CONFIG=/config/service.json \
    JACKBIRD_LIBRARY=/library \
    JACKBIRD_LISTEN=0.0.0.0 \
    JACKBIRD_MACHINE=gateway
USER jackbird
VOLUME ["/config", "/library"]
EXPOSE 4646
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:4646/api/info || exit 1
ENTRYPOINT ["jackbird-service"]
