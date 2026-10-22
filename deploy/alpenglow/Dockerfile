# Alpenglow (Votor) validator image. Agave v4.3.2 solana-test-validator with --alpenglow at genesis.
# NEW GENESIS: booting this on an existing v2.2 ledger is not supported. See RELEASE.md.
FROM debian:bookworm-slim
ARG AGAVE_VERSION=v4.3.2
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 nodejs && rm -rf /var/lib/apt/lists/* \
 && curl -sSfL https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C /opt \
 && ln -s /opt/solana-release/bin/* /usr/local/bin/
COPY proxy.js /proxy.js
COPY lib/priority-fee.js /lib/priority-fee.js
COPY lib/shield-limits.js /lib/shield-limits.js
COPY brain /brain
COPY deploy/alpenglow/start.sh /start.sh
RUN chmod +x /start.sh
ENV PORT=8080
CMD ["/start.sh"]
