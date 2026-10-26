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
USER node
CMD ["node", "app.js"]
