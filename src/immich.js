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
        const form = new FormData();
        form.append('deviceAssetId', deviceAssetId);
        form.append('deviceId', 'immich-transfer-web');
        form.append('fileCreatedAt', metadata.createdAt);
        form.append('fileModifiedAt', metadata.modifiedAt);
        form.append('isFavorite', metadata.isFavorite ? 'true' : 'false');

        // 1. Ana Medya Akışı (Image / Standalone Video)
        let mainStream;
        if (item.isZip) {
          mainStream = await ArchiveScanner.openZipEntryStream(item.zipPath, item.entryName);
        } else {
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

        // 2. Canlı / Hareketli Fotoğraf (Live Photo / Motion Photo Video Akışı)
        if (item.isLivePhoto) {
          let videoStream;
          const videoName = item.livePhotoVideoName || 'motion.mov';
          const videoMime = mime.lookup(videoName) || 'video/quicktime';

          if (item.isZip && item.livePhotoVideoEntry) {
            videoStream = await ArchiveScanner.openZipEntryStream(item.zipPath, item.livePhotoVideoEntry);
          } else if (item.livePhotoVideoPath) {
            videoStream = fs.createReadStream(item.livePhotoVideoPath);
          }

          if (videoStream) {
            if (onProgressChunk) {
              videoStream.on('data', (chunk) => {
                onProgressChunk(chunk.length);
              });
            }

            form.append('livePhotoData', videoStream, {
              filename: videoName,
              contentType: videoMime,
              knownLength: item.livePhotoVideoSize
            });
          }
        }

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
