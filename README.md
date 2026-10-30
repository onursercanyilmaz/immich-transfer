# Immich Google Takeout Transfer Tool

Google Takeout ile indirilen devasa fotoğraf ve video arşivlerini (120 GB+) self-hosted **Immich** sunucunuza aktaran yüksek performanslı, dayanıklı ve şık terminal arayüzüne sahip Python betiği.

## Öne Çıkan Özellikler

1. **Paralel & Eşzamanlı Yükleme (Multi-threading):** `CONCURRENCY` ayarı ile birden fazla dosyayı aynı anda yükleyerek bant genişliğini ve ev ağını maksimum verimle kullanır (Örn: 4-8 thread).
2. **Hesap Doğrulama:** Başlangıçta Immich `/api/users/me` endpoint'ine bağlanarak ad, e-posta ve sunucu bilgilerini listeler, aktarım için kullanıcı onayı ister.
3. **Akıllı Google Takeout JSON Eşleştirme:**
   - Standart `foto.jpg.json` ve `foto.json` biçimlerini tanır.
   - Google Takeout'un kopya dosyalarındaki `foto(1).jpg` $\rightarrow$ `foto.jpg(1).json` eşleştirmelerini çözer.
   - 46-51 karakterden sonra kırpılan uzun dosya adı JSON'larını otomatik yakalar.
   - `photoTakenTime.timestamp` değerini milisaniyelik UTC ISO-8601 tarihine dönüştürür.
4. **Gerçek Zamanlı Terminal Paneli (Rich):**
   - **% İlerleme Çubuğu**
   - **Birleşik Anlık Transfer Hızı (MB/s)** (Tüm paralel iş parçacıklarının toplam bant genişliğini canlı hesaplar)
   - **Kalan Tahmini Süre (ETA)**
   - **GB ve Dosya Sayaçları** (`12.450 / 35.000` dosya, `51.2 / 120.5 GB`)
5. **Thread-Safe Kesinti Koruması (Resume / Checkpoint):**
   - Yerel `checkpoint.db` (SQLite) sayesinde internet kopsa, elektrik gitse veya terminal kapansa bile tekrar çalıştırıldığında yüklenmiş dosyaları anında atlar ve kaldığı yerden devam eder.
6. **Duplicate Yönetimi:**
   - Immich sunucusunda zaten var olan dosyalar çökme yaratmaz; `SKIPPED_DUPLICATE` olarak işaretlenir.
7. **Güvenlik:**
   - API anahtarları ve özel adresler `.env` dosyasında tutulur, git deposuna asla commit edilmez.

---

## Kurulum

### 1. Depoyu Klonlayın veya İlgili Dizine Geçin
```bash
cd immich-transfer
```

### 2. Python Sanal Ortamını (venv) Oluşturun ve Aktive Edin
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Bağımlılıkları Yükleyin
```bash
pip install -r requirements.txt
```

### 4. Yapılandırma (.env) Dosyasını Oluşturun
`.env.example` dosyasını kopyalayın:
```bash
cp .env.example .env
```

`.env` dosyasını düzenleyin:
```ini
# Immich Sunucu Adresi (Örn: http://192.168.1.100:2283 veya https://immich.evim.local)
IMMICH_INSTANCE_URL=http://your-immich-ip:2283

# Immich Web Arayüzü -> Account Settings -> API Keys kısmından aldığınız anahtar
IMMICH_API_KEY=your_api_key_here

# Google Takeout arşivinizin klasör yolu
TAKEOUT_DIR=/Users/onur/Downloads/Google Photos
```

---

## Çalıştırma

```bash
python3 transfer.py
```

### Çalışma Aşamaları:
1. Immich sunucusuna bağlanır, bağlı kullanıcı hesabını gösterir ve onayınızı alır.
2. Klasörü tarar, toplam medya adedini, GB boyutunu ve varsa daha önce yüklenenleri hesaplayıp özetler.
3. Onayınızla birlikte transferi başlatır; terminalde anlık hız, yüzde ve kalan süreyi gösterir.
4. Olası hataları `failed_uploads.log` dosyasına yazar.
