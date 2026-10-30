FROM node:20-alpine

WORKDIR /app

# Paket bağımlılıklarını yükle
COPY package*.json ./
RUN npm install --omit=dev

# Uygulama kaynak kodunu kopyala
COPY . .

# Veri ve Takeout dizinleri için varsayılan ortam değişkenleri
ENV PORT=3000
ENV DATA_DIR=/data
ENV TAKEOUT_DIR=/takeout

EXPOSE 3000

CMD ["node", "src/server.js"]
