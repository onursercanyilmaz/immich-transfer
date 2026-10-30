const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const mime = require('mime-types');
const ArchiveScanner = require('./takeout');

class ImmichClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiUrl = this.baseUrl.endsWith('/api') ? this.baseUrl : `${this.baseUrl}/api`;
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json'
      },
      timeout: 300000 // 5 dakika büyük videolar için
    });
  }

  async getCurrentUser() {
    try {
      const res = await this.client.get('/users/me', { timeout: 15000 });
      return res.data;
    } catch (err) {
      if (err.response) {
        if (err.response.status === 401 || err.response.status === 403) {
          throw new Error('API Anahtarı geçersiz veya yetkisiz!');
        }
        throw new Error(`Immich HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
      throw new Error(`Immich sunucusuna bağlanılamadı: ${err.message}`);
    }
  }

  /**
   * Medya dosyasını (ve varsa Live Photo video bileşenini) Immich'e aktarır.
   * item: Medya nesnesi veya doğrudan dosya yolu string'i
   */
  async uploadAsset(itemOrPath, metadata, onProgressChunk = null, maxRetries = 3) {
    let item;
    if (typeof itemOrPath === 'string') {
      const stat = fs.statSync(itemOrPath);
      item = {
        isZip: false,
        fullPath: itemOrPath,
        name: path.basename(itemOrPath),
        size: stat.size,
        isLivePhoto: false
      };
    } else {
      item = itemOrPath;
    }

    const filename = item.name;
    const mimeType = mime.lookup(filename) || 'application/octet-stream';

    // Unique deviceAssetId üretimi
    const rawId = `${filename}_${item.size}_${metadata.createdAt}`;
    const deviceAssetId = crypto.createHash('sha1').update(rawId).digest('hex');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let livePhotoVideoId = null;

        // 1. Canlı / Hareketli Fotoğraf (Live Photo Video Bileşeni)
        // Immich API Kuralı: Video önce /api/assets endpoint'ine yüklenip UUID alınır.
        // Ardından ana fotoğraf bu livePhotoVideoId parametresi ile yüklenir.
        // (Doğrudan multipart formunda livePhotoData alanı Immich tarafından beklenmeyen alan hatası verir)
        if (item.isLivePhoto) {
          try {
            let videoStream;
            const videoName = item.livePhotoVideoName || 'motion.mov';
            const videoMime = mime.lookup(videoName) || 'video/quicktime';

            if (item.isZip && item.livePhotoVideoEntry) {
              videoStream = await ArchiveScanner.openZipEntryStream(item.zipPath, item.livePhotoVideoEntry);
            } else if (item.livePhotoVideoPath && fs.existsSync(item.livePhotoVideoPath)) {
              videoStream = fs.createReadStream(item.livePhotoVideoPath);
            }

            if (videoStream) {
              const videoRawId = `${videoName}_${item.livePhotoVideoSize}_${metadata.createdAt}`;
              const videoDeviceId = crypto.createHash('sha1').update(videoRawId).digest('hex');

              const videoForm = new FormData();
              videoForm.append('deviceAssetId', videoDeviceId);
              videoForm.append('deviceId', 'immich-transfer-web');
              videoForm.append('fileCreatedAt', metadata.createdAt);
              videoForm.append('fileModifiedAt', metadata.modifiedAt);
              videoForm.append('isFavorite', 'false');
              videoForm.append('assetData', videoStream, {
                filename: videoName,
                contentType: videoMime,
                knownLength: item.livePhotoVideoSize
              });

              const videoRes = await this.client.post('/assets', videoForm, {
                headers: videoForm.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                validateStatus: (status) => (status >= 200 && status < 300) || status === 409
              });

              if (videoRes.data?.id) {
                livePhotoVideoId = videoRes.data.id;
              }
            }
          } catch (vidErr) {
            console.warn(`[ImmichClient] Live Photo video yükleme uyarısı (${item.name}):`, vidErr.message);
          }
        }

        // 2. Ana Medya Akışı (Image / Standalone Video)
        const form = new FormData();
        form.append('deviceAssetId', deviceAssetId);
        form.append('deviceId', 'immich-transfer-web');
        form.append('fileCreatedAt', metadata.createdAt);
        form.append('fileModifiedAt', metadata.modifiedAt);
        form.append('isFavorite', metadata.isFavorite ? 'true' : 'false');
        if (livePhotoVideoId) {
          form.append('livePhotoVideoId', livePhotoVideoId);
        }

        let mainStream;
        if (item.isZip) {
          mainStream = await ArchiveScanner.openZipEntryStream(item.zipPath, item.entryName);
        } else {
          if (!fs.existsSync(item.fullPath)) {
            return {
              success: false,
              status: 'ERROR',
              error: `Dosya diskte bulunamadı (Taşınmış veya silinmiş olabilir): ${item.fullPath}`
            };
          }
          mainStream = fs.createReadStream(item.fullPath);
        }

        if (onProgressChunk) {
          mainStream.on('data', (chunk) => {
            onProgressChunk(chunk.length);
          });
        }

        const assetLength = item.imageSize || item.size;
        form.append('assetData', mainStream, {
          filename,
          contentType: mimeType,
          knownLength: assetLength
        });

        const res = await this.client.post('/assets', form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          validateStatus: (status) => (status >= 200 && status < 300) || status === 409
        });

        if (res.status === 409 || res.data?.status === 'duplicate') {
          return { success: true, status: 'DUPLICATE', id: res.data?.id || '' };
        }

        return { success: true, status: 'SUCCESS', id: res.data?.id || '' };
      } catch (err) {
        const isNetworkOr5xx = !err.response || (err.response.status >= 500 && err.response.status <= 504);
        if (isNetworkOr5xx && attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
          continue;
        }

        const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        return { success: false, status: 'ERROR', error: msg };
      }
    }

    return { success: false, status: 'ERROR', error: `Maksimum deneme aşıldı (${maxRetries})` };
  }
}

module.exports = ImmichClient;
