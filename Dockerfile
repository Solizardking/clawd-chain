FROM debian:bookworm-slim
ARG AGAVE_VERSION=v2.2.20
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 nodejs && rm -rf /var/lib/apt/lists/* \
 && curl -sSfL https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C /opt \
 && ln -s /opt/solana-release/bin/* /usr/local/bin/
COPY proxy.js /proxy.js
COPY start.sh /start.sh
RUN chmod +x /start.sh
ENV PORT=8080
CMD ["/start.sh"]
