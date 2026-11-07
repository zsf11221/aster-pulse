# Aster Pulse — 香港服务器 Docker 镜像（零依赖，Node 20）
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
COPY app/ ./app/
RUN mkdir -p data/cache && node --check server.js && node --check app/worker.js
ENV PORT=3000 HOST=0.0.0.0 CACHE_DIR=/app/data/cache NODE_ENV=production
EXPOSE 3000
# 缓存落盘在 /app/data，容器重建不丢：compose 里挂 volume
VOLUME ["/app/data"]
CMD ["node", "server.js"]
