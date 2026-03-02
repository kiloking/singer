# Singer - 自動歌詞工具
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3847

ENV PORT=3847
CMD ["node", "server.js"]
