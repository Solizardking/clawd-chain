FROM node:20-slim
WORKDIR /app
COPY server.js quota.js pow.js feed.js index.html ./
ENV PORT=8080
CMD ["node", "server.js"]
