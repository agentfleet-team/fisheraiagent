FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Build identity baked in at build time (release builds pass
# --build-arg APP_VERSION=vX.Y.Z --build-arg APP_COMMIT=<sha>); a plain
# local build reports the dev defaults.
ARG APP_VERSION=0.0.0-dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=${APP_VERSION} APP_COMMIT=${APP_COMMIT}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY web ./web
ENTRYPOINT ["node"]
CMD ["dist/server.js"]
