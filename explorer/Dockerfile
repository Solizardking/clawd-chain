FROM node:20-slim
WORKDIR /app
COPY explorer/server.js ./server.js
COPY explorer/public ./public
COPY mint ./mint
COPY chain/public-mint.js ./chain/public-mint.js
COPY chain/market.js ./chain/market.js
ENV PORT=8080
ENV MINT_DIR=/app/mint
ENV CHAIN_DIR=/app/chain
CMD ["node", "server.js"]
