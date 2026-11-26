FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY proxy.js server.js sshTransport.js ./
USER node
ENV PORT=8080
CMD ["node", "server.js"]
