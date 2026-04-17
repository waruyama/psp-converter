FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
WORKDIR /workspace
ENTRYPOINT ["node", "/app/index.js"]
