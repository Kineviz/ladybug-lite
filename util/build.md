# 1. 在宿主机（非容器内）安装 QEMU
# sudo apt-get install qemu-user-static  # Debian/Ubuntu

# re-install @ladybugdb/core for clean all build info
yarn remove @ladybugdb/core 
yarn add @ladybugdb/core --no-cache


# 2. run qemu-aarch64-alpine and qemu-amd64-alpine


docker rm -f qemu-aarch64-alpine \
&& \
docker run -it \
--name qemu-aarch64-alpine \
-v ./:/app \
--platform linux/arm64 \
node:22-alpine


 
docker rm -f qemu-amd64-alpine \
&& \
docker run -it \
--platform linux/amd64 \
-v ./:/app \
--name qemu-amd64-alpine \
node:22-alpine



# 3. go to ladybug source

cd /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api


# 4. run ***yarn***

yarn install --no-cache
 

# 5. install  dependencies  (alpine)
apk add --no-cache -X https://mirrors.aliyun.com/alpine/v3.21/main  \
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

# 5.1 install  dependencies  (ubuntu)

sudo apt update
sudo apt install -y \
    g++ \
    make \
    cmake \
    python3 \
    libssl-dev \
    zlib1g-dev \
    musl-tools \
    musl-dev \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    build-essential \
    pkg-config \
    wget \
    curl




# 6.  yarn build

```sh
# 替换 build.js 文件中的 "THREADS =" 为 "THREADS = 2;//"
sed -i 's/THREADS =/THREADS = 2;\/\//' build.js
```

```
yarn build
```
 

# 7.  copy the lbugjs.node to lbugjs-alpine-arm64.node
cp -f /app/node_modules/@ladybugdb/core/lbug-source/tools/nodejs_api/build/lbugjs.node /app/node_modules/@ladybugdb/core/prebuilt/lbugjs-alpine-arm64.node
