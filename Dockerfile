FROM node:22-alpine

ENV NODE_ENV=production PORT=5000
WORKDIR /app

# No npm dependencies: just copy the server and static files.
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:5000/healthz || exit 1

CMD ["node", "server/server.js"]
