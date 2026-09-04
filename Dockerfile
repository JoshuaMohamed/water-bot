# node:sqlite (used by store.js) needs Node 22+; 24 is current LTS.
FROM node:24-slim

ENV NODE_ENV=production

# Install required OS dependencies for Chromium / Puppeteer
RUN apt-get update && apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libgbm1 \
  libgdk-pixbuf2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxshmfence1 \
  wget \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Use system Chromium instead of Puppeteer's downloaded binary (avoids qemu issues)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV TZ=UTC

# Install Chromium (system package) and dependencies
RUN apt-get update && (apt-get install -y chromium --no-install-recommends || apt-get install -y chromium-browser --no-install-recommends) && rm -rf /var/lib/apt/lists/*

# Install dependencies first (use lockfile if present)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Persist SQLite + WhatsApp session outside the image layers.
# NOTE: Railway does not support the Docker VOLUME instruction, so do NOT
# add VOLUME here. Instead attach a Railway Volume mounted at /data in the
# service settings (Variables / Volumes tab) to persist DB + session.
# (No HEALTHCHECK: this is a WhatsApp worker with no HTTP port;
# liveness = process running, so use a restart policy instead.)
ENV DB_PATH=/data/water.db
ENV WWEBJS_AUTH_PATH=/data/.wwebjs_auth
RUN mkdir -p /data

CMD ["npm", "run", "start"]
