FROM node:24-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY server.js database.js rss-manager.js app.js index.html styles.css rss-feeds.txt package.json ./
# npm is not used at runtime (CMD is `node server.js`). Remove it so the base
# image's bundled npm (which vendors a vulnerable undici) is not shipped.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
EXPOSE 3000
CMD ["node", "server.js"]
