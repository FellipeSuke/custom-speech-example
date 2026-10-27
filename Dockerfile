FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev
RUN apk del .build-deps
COPY . .
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
USER node
CMD ["node", "app.js"]
