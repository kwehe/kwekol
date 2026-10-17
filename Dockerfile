FROM node:20-slim
WORKDIR /app
COPY kwekol-server/package*.json ./
RUN npm install --omit=dev
COPY kwekol-server/ ./
COPY kwekol.html kwekol.png ./
ENV APP_DIR=/app DATA_DIR=/data HOST=0.0.0.0 PORT=3000
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
