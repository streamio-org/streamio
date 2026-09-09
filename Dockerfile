FROM node:24-alpine

# ffmpeg: transcodes local-provider uploads to HLS
# (services/transcode.service.ts) — a non-Docker dev run needs ffmpeg/ffprobe
# on PATH too.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# Build stamp. The image has no .git to inspect at runtime, so the commit is
# baked in here and read by version.ts; "unknown" is fine for a local build.
ARG GIT_SHA=unknown
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/index.js"]