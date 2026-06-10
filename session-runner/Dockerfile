FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git gzip openssh-client python3 make g++ tar \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./

RUN mkdir -p /workspace /root/.pi
ENV PORT=8080
ENV WORKSPACE_DIR=/workspace

EXPOSE 8080
CMD ["npm", "start"]
