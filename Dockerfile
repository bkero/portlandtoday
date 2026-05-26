FROM node:24-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY server.js database.js rss-manager.js app.js index.html styles.css rss-feeds.txt package.json ./
EXPOSE 3000
CMD ["node", "server.js"]
