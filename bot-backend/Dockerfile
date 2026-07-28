FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production
ENV STATE_PATH=/app/data/state.json
EXPOSE 3000
CMD ["node", "src/index.js"]
