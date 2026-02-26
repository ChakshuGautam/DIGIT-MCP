FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist dist/
RUN mkdir -p /app/data
ENV MCP_TRANSPORT=http
ENV SESSION_DATA_DIR=/app/data
ENV MCP_PORT=3000
ENV SESSION_DB_HOST=localhost
ENV SESSION_DB_PORT=15433
ENV SESSION_DB_NAME=mcp_sessions
ENV SESSION_DB_USER=mcp
ENV SESSION_DB_PASSWORD=mcp123
EXPOSE 3000
CMD ["node", "dist/index.js"]
