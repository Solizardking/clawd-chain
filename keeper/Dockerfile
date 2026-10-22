FROM node:22-bookworm-slim
WORKDIR /srv
COPY keeper.js .
ENV PRICES_FILE=/data/prices.json
CMD ["node", "keeper.js"]
