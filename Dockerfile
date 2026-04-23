# syntax=docker/dockerfile:1.4

# ----- amd64 构建 -----
FROM --platform=linux/amd64 node:22-alpine  AS build-amd64
WORKDIR /app
RUN echo "Building for $(uname -m)"
RUN apk add --no-cache  \
    g++ \
    gcompat \
    libc6-compat \
    build-base \
    python3 \
    libressl-dev \
    make \
    cmake \
    zlib-dev \
    musl-dev

RUN yarn cache clean && yarn add @ladybugdb/core --force
RUN cd /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api && \
    yarn install
RUN yarn build

RUN mkdir -p /app/node_modules/@ladybugdb/core/prebuilt  && \
    cp -f /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api/build/lbugjs.node /app/node_modules/@ladybugdb/core/prebuilt/lbugjs-linux-amd64.node

# ----- arm64 构建 -----
FROM --platform=linux/arm64 node:22-alpine  AS build-arm64
WORKDIR /app
RUN echo "Building for $(uname -m)"
RUN apk add --no-cache \
    g++ \
    gcompat \
    libc6-compat \
    build-base \
    python3 \
    libressl-dev \
    make \
    cmake \
    zlib-dev \
    musl-dev

RUN yarn cache clean && yarn add @ladybugdb/core --force
RUN cd /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api && \
    yarn install
RUN yarn build

RUN mkdir -p /app/node_modules/@ladybugdb/core/prebuilt  && \
    cp -f /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api/build/lbugjs.node /app/node_modules/@ladybugdb/core/prebuilt/lbugjs-linux-arm64.node
