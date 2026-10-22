FROM node:20-slim
WORKDIR /app
COPY server.js ./
COPY lib ./lib
ENV PORT=8080
CMD ["node", "server.js"]
