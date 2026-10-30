# 🚀 Immich Google Takeout Migrator (Web UI & Docker)

Google Takeout ile indirilen devasa fotoğraf ve video arşivlerini (120 GB+) self-hosted **Immich** sunucunuza kolayca, güvenle ve yüksek hızla aktarmanızı sağlayan modern, Docker destekli ve web arayüzlü göç aracı.

Terminal komutlarıyla veya karmaşık `.env` ayarlarıyla uğraşmak istemeyenler için **tek komutla** ayağa kalkar ve tarayıcınızda şık bir kontrol paneli sunar.

---

## 🌟 Öne Çıkan Özellikler

- 🌐 **Modern Web Arayüzü (Dashboard):** Terminalle uğraşmadan tarayıcınız üzerinden tüm süreci yönetin.
- 🐳 **Docker & Docker Compose ile Tek Tıkla Kurulum:** Hiçbir bağımlılık (Python, Node.js vb.) kurmanıza gerek kalmadan doğrudan Docker ile çalışır.
- ⚡ **Eşzamanlı (Paralel) Yükleme:** Ayarlanabilir thread/worker havuzu ile (1-10 paralel akış) ev ağınızın ve diskinizin maksimum hızına ulaşır.
- 📊 **Gerçek Zamanlı Metrikler:**
  - Canlı yüzde göstergesi (`%`)
  - Anlık transfer hızı (`MB/s`)
  - Kalan tahmini süre (`ETA`)
  - Başarılı, atlanan (duplicate) ve hatalı dosya sayaçları
  - O anda hangi iş parçacığının hangi dosyayı yüklediğini gösteren canlı worker paneli
- 🧠 **Akıllı Google Takeout Eşleştirici:**
  - `foto.jpg.json` ve `foto.json` formatlarını otomatik tanır.
  - Takeout'un kopya dosyalarındaki `foto(1).jpg` $\leftrightarrow$ `foto.jpg(1).json` garipliklerini çözer.
  - 46-51 karakterden sonra kırpılan uzun dosya isimli JSON'ları yakalar.
  - `photoTakenTime.timestamp` değerini milisaniyelik UTC ISO-8601 tarihine çevirerek Immich'e aktarır.
- 💾 **Elektrik / Kapanma Korumalı Checkpoint (fsync):**
  - Bilgisayar aniden kapansa dahi aktarılan her dosya `fsync` güvencesiyle diske yazılır. Yeniden başlatıldığında kaldığı yerden anında devam eder.
- 📜 **Canlı Konsol ve Log İndirme:** Web arayüzünde canlı kayan terminal penceresi ve tek tıkla `transfer.log` dosyasını indirebilme imkanı.

---

## 🚀 Hızlı Başlangıç (Docker ile)

### 1. Depoyu İndirin
```bash
git clone https://github.com/your-username/immich-transfer.git
cd immich-transfer
```

### 2. `docker-compose.yml` Dosyasını Düzenleyin
`docker-compose.yml` dosyasındaki Takeout klasör yolunuzu kendi bilgisayarınızdaki yolla güncelleyin:

```yaml
services:
  immich-transfer:
    build: .
    container_name: immich-transfer
    ports:
      - "3000:3000"
    volumes:
      # Kendi Google Takeout klasörünüzün yolunu yazın (Salt Okunur / Read-Only):
      - /Users/onur/Downloads/Google Photos:/takeout:ro
      # Checkpoint ve logların bilgisayarınızda kalıcı olması için:
      - ./data:/data
    restart: unless-stopped
```

### 3. Çalıştırın
```bash
docker compose up -d
```

Tarayıcınızdan **`http://localhost:3000`** adresine gidin ve aktarımı başlatın!

---

## 💻 Docker Olmadan Çalıştırma (Node.js)

Eğer Docker kullanmak istemiyorsanız yerel Node.js ile de çalıştırabilirsiniz:

```bash
# 1. Bağımlılıkları yükleyin
npm install

# 2. Sunucuyu başlatın
npm start
```
Tarayıcınızda `http://localhost:3000` adresini açarak kullanabilirsiniz.

---

## 🐍 Alternatif: Python CLI Sürümü

Web arayüzü yerine doğrudan terminalde CLI aracı olarak çalıştırmak isterseniz projede yer alan `transfer.py` betiğini de kullanabilirsiniz:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # .env dosyasını doldurun
python3 transfer.py
```

---

## 🔒 Güvenlik

- API anahtarları veya kişisel sunucu bilgileri hiçbir zaman koda gömülmez.
- `.gitignore` ve `.dockerignore` dosyaları yerel `.env`, `.log` ve `data/` klasörlerinin git reposuna sızmasını engeller.

## 📄 Lisans
MIT License. Dilediğiniz gibi kullanabilir, özelleştirebilir ve paylaşabilirsiniz.
