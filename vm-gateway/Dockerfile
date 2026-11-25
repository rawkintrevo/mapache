FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY proxy.js server.js ./
USER node
ENV PORT=8080
CMD ["node", "server.js"]
