# 🚀 Immich Google Takeout Migrator (Web UI & Docker)

[🇹🇷 Türkçe](#-türkçe) | [🇬🇧 English](#-english)

---

## 🇹🇷 Türkçe

Google Takeout ile indirilen devasa fotoğraf ve video arşivlerini (120 GB+) self-hosted **Immich** sunucunuza kolayca, güvenle ve yüksek hızla aktarmanızı sağlayan modern, Docker destekli ve web arayüzlü göç aracı.

Terminal komutlarıyla veya karmaşık `.env` ayarlarıyla uğraşmak istemeyenler için **tek komutla** ayağa kalkar ve tarayıcınızda şık bir kontrol paneli sunar.

### 🌟 Öne Çıkan Özellikler

- 🌐 **Modern Web Arayüzü (Dashboard):** Türkçe ve İngilizce dil desteği (🇹🇷 TR / 🇬🇧 EN).
- 🐳 **Docker & Docker Compose ile Tek Tıkla Kurulum:** Hiçbir bağımlılık (Python, Node.js vb.) kurmanıza gerek kalmadan doğrudan Docker ile çalışır.
- ⚡ **Eşzamanlı (Paralel) Yükleme:** Ayarlanabilir worker havuzu ile (1-10 paralel akış) ev ağınızın ve diskinizin maksimum hızına ulaşır.
- 📊 **Gerçek Zamanlı Metrikler:** Canlı yüzde göstergesi (`%`), anlık transfer hızı (`MB/s`), kalan tahmini süre (`ETA`) ve sayaçlar.
- 🧠 **Akıllı Google Takeout Eşleştirici:** `foto.jpg.json`, `foto.json`, `foto(1).jpg` $\leftrightarrow$ `foto.jpg(1).json` ve kırpılmış isimleri otomatik çözer.
- 💾 **Elektrik / Kapanma Korumalı Checkpoint (fsync):** Bilgisayar kapansa bile aktarılan her dosya `fsync` güvencesiyle diske yazılır, kaldığı yerden devam eder.
- 📜 **Canlı Konsol ve Log İndirme:** Web arayüzünde canlı kayan terminal penceresi ve tek tıkla `transfer.log` dosyasını indirebilme imkanı.

### 🚀 Hızlı Başlangıç (Docker ile)

```yaml
# docker-compose.yml
services:
  immich-transfer:
    build: .
    container_name: immich-transfer
    ports:
      - "3000:3000"
    volumes:
      # Kendi Google Takeout klasörünüzün yolunu yazın (Salt Okunur / Read-Only):
      - /path/to/Google Photos:/takeout:ro
      # Checkpoint ve logların bilgisayarınızda kalıcı olması için:
      - ./data:/data
    restart: unless-stopped
```

```bash
docker compose up -d
```
Tarayıcınızdan **`http://localhost:3000`** adresine gidin ve aktarımı başlatın!

---

## 🇬🇧 English

A modern, Dockerized web-based migration tool designed to easily, safely, and rapidly transfer massive Google Takeout photo and video archives (120 GB+) into your self-hosted **Immich** server.

Designed for zero friction: launch with a single command without dealing with complex command lines or configuration files.

### 🌟 Key Features

- 🌐 **Modern Web Dashboard:** Full bilingual support (🇹🇷 TR / 🇬🇧 EN) with language toggle.
- 🐳 **Zero-Dependency Docker Deployment:** Runs instantly using Docker & Docker Compose without needing local Python or Node.js runtimes.
- ⚡ **Multi-Threaded Parallel Uploads:** Adjustable worker pool (1-10 concurrency) to saturate your local network and storage speeds.
- 📊 **Real-time Live Metrics:** Dynamic progress bar (`%`), current upload speed (`MB/s`), remaining time (`ETA`), and live active worker status.
- 🧠 **Smart Google Takeout Sidecar Matcher:**
  - Handles `photo.jpg.json` and `photo.json`
  - Resolves duplicate naming anomalies: `photo(1).jpg` $\leftrightarrow$ `photo.jpg(1).json`
  - Truncated name recovery (46-51 character limits)
  - Extracts `photoTakenTime.timestamp` to authoritative UTC ISO-8601 timestamps.
- 💾 **Power-Loss & Crash Resilient (fsync Checkpoint):** Each uploaded asset is written with immediate `fsync` flushing. If power is cut or your machine reboots, it immediately skips existing files and resumes right where it stopped.
- 📜 **Live Console & Log Export:** Real-time log stream via Server-Sent Events (SSE) and one-click `transfer.log` download.

### 🚀 Quick Start (Docker)

1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/immich-transfer.git
   cd immich-transfer
   ```

2. Edit `docker-compose.yml` to point to your Google Takeout folder:
   ```yaml
   volumes:
     - /path/to/Google Photos:/takeout:ro
     - ./data:/data
   ```

3. Start the container:
   ```bash
   docker compose up -d
   ```

Open **`http://localhost:3000`** in your browser, enter your Immich URL & API Key, verify your account, and hit **Start Migration**!

### 💻 Running without Docker (Node.js)

```bash
npm install
npm test    # Run automated test suite
npm start   # Starts web UI on http://localhost:3000
```

### 📄 License
MIT License. Free to use, modify, and distribute.
