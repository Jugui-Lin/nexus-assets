FROM rust:1.100.0-bookworm AS build
WORKDIR /build
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs ./src-tauri/
COPY src-tauri/src/ ./src-tauri/src/
COPY resources/demo/ ./resources/demo/
RUN cargo build --manifest-path src-tauri/Cargo.toml --locked --release --jobs 2 --no-default-features --bin nexus-team

FROM debian:bookworm-slim AS baidu
ARG TARGETARCH
RUN set -eu; \
    mkdir -p /output; \
    if [ "${TARGETARCH:-amd64}" = amd64 ]; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl; \
      curl -fsSL --retry 3 -o /tmp/bdpan.tar.gz \
        https://issuecdn.baidupcs.com/issue/netdisk/ai-bdpan/linux-amd/3.8.9/bdpan-3.8.9-linux-amd64.tar.gz; \
      echo '0d87f71b31f07024c18e7b74ac5d3ab321b44ce068eaea5eb6bc81e7a94c1c9c  /tmp/bdpan.tar.gz' | sha256sum -c; \
      tar -xzf /tmp/bdpan.tar.gz -O bdpan/bdpan > /output/bdpan; \
      echo 'f6d4c4877e03881af30d79aeb9844e8d0ff324b7649c88dc46f8ca90e4b0bee5  /output/bdpan' | sha256sum -c; \
      chmod 0755 /output/bdpan; \
    fi

FROM debian:bookworm-slim AS team-core
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/src-tauri/target/release/nexus-team /usr/local/bin/nexus-team
USER 1000:1000
RUN ["/usr/local/bin/nexus-team", "--help"]
ENTRYPOINT ["/usr/local/bin/nexus-team"]
CMD ["--help"]

# Local deployments also bundle the optional provider.
FROM team-core AS team
COPY --from=baidu /output/ /usr/local/bin/
