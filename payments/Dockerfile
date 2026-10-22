FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY lib/payments.js ./lib/payments.js
COPY payments/server.js payments/registry.js ./payments/
COPY payments/public ./payments/public
ENV REGISTRY_FILE=/data/payments/registry.json
ENV PORT=8090
CMD ["node", "payments/server.js"]
