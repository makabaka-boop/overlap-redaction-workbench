# --- 构建阶段：安装依赖、类型检查、Vitest 验收、Vite 构建 ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY test ./test
RUN npm test && npm run build

# --- 运行阶段：nginx 托管静态产物，端口可用 WEB_PORT 覆盖 ---
FROM nginx:1.27-alpine AS runtime
# 容器内监听端口可由 WEB_PORT 覆盖（默认 8080，非特权端口）
ENV WEB_PORT=8080
COPY docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
# nginx:alpine 镜像入口脚本会用 envsubst 渲染 /etc/nginx/templates/*.template
CMD ["nginx", "g", "daemon off;"]
