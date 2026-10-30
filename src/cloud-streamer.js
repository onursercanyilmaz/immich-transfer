const axios = require('axios');
const yauzl = require('yauzl');
const path = require('path');
const { PassThrough } = require('stream');
const CurlParser = require('./curl-parser');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
  '.gif', '.dng', '.raw', '.cr2', '.nef', '.arw'
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'
]);

class CloudTakeoutStreamer {
  /**
   * Google Takeout indirme bağlantısını doğrular ve arşiv boyutunu alır
   * @param {string} curlOrUrl - cURL komutu veya doğrudan URL
   */
  static async validateLink(curlOrUrl) {
    const config = CurlParser.parse(curlOrUrl);
    console.log('[CloudTakeoutStreamer] Hedef URL:', config.url);
    console.log('[CloudTakeoutStreamer] Header Anahtarları:', Object.keys(config.headers));

    try {
      // 1 baytlık Range isteği ile bağlantıyı, çerezleri ve dosya boyutunu test et
      let res = await axios.get(config.url, {
        headers: {
          ...config.headers,
          'Range': 'bytes=0-0'
        },
        maxRedirects: 10,
        beforeRedirect: (options) => {
          // Cross-domain yönlendirmede Google oturum çerezlerini ve Range başlığını koru
          if (config.headers['Cookie']) options.headers['Cookie'] = config.headers['Cookie'];
          if (config.headers['cookie']) options.headers['cookie'] = config.headers['cookie'];
          options.headers['Range'] = 'bytes=0-0';
        },
        validateStatus: status => (status >= 200 && status < 400)
      });

      let finalUrl = res.request?.res?.responseUrl || config.url;

      // Eğer yönlendirme (redirect) gerçekleştiyse ve ilk yanıt 206 dönmediyse, asıl hedefe doğrudan Range at
      if (finalUrl !== config.url && res.status !== 206) {
        try {
          const directRes = await axios.get(finalUrl, {
            headers: {
              ...config.headers,
              'Range': 'bytes=0-0'
            },
            maxRedirects: 5,
            validateStatus: s => s < 400
          });
          if (directRes.status === 206 || directRes.headers['content-range'] || directRes.headers['accept-ranges']) {
            res = directRes;
          }
        } catch (_) {}
      }

      console.log('[CloudTakeoutStreamer] Yanıt Status:', res.status);
      console.log('[CloudTakeoutStreamer] Yanıt Content-Type:', res.headers['content-type']);
      console.log('[CloudTakeoutStreamer] Yanıt Content-Range:', res.headers['content-range']);
      console.log('[CloudTakeoutStreamer] Yanıt Content-Length:', res.headers['content-length']);
      console.log('[CloudTakeoutStreamer] Yanıt Final URL:', res.request?.res?.responseUrl || config.url);

      let contentType = (res.headers['content-type'] || '').toLowerCase();

      // Eğer sunucu bir HTML sayfası döndürdüyse (Google Login veya Takeout Web sayfası)
      // Sayfa içindeki gizli gerçek indirme linkini (takeout-download veya .zip) otomatik tara
      if (contentType.includes('text/html')) {
        let htmlBody = '';
        if (typeof res.data === 'string') {
          htmlBody = res.data;
        } else if (Buffer.isBuffer(res.data)) {
          htmlBody = res.data.toString('utf8');
        }

        console.log('[CloudTakeoutStreamer] HTML sayfası alındı, içindeki indirme bağlantısı taranıyor...');

        // HTML içindeki gerçek CDN indirme linkini yakala
        const urlPatterns = [
          /https?:\/\/[^\s"'<>]*(?:takeout-download|usercontent\.google\.com)[^\s"'<>]+/i,
          /<a\s+(?:[^>]*?\s+)?href=["'](https?:\/\/[^"'>]+)["']/i,
          /window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i,
          /<meta\s+http-equiv=["']refresh["']\s+content=["'][^"']*url=([^"'>]+)["']/i
        ];

        let extractedDownloadUrl = null;
        for (const pattern of urlPatterns) {
          const match = htmlBody.match(pattern);
          if (match) {
            extractedDownloadUrl = match[1] || match[0];
            break;
          }
        }

        if (extractedDownloadUrl) {
          console.log('[CloudTakeoutStreamer] HTML içerisinden gerçek CDN linki çıkarıldı:', extractedDownloadUrl);
          // Çıkarılan bu gerçek indirme adresine doğrudan Range isteği at
          res = await axios.get(extractedDownloadUrl, {
            headers: {
              ...config.headers,
              'Range': 'bytes=0-0'
            },
            maxRedirects: 10,
            validateStatus: s => (s >= 200 && s < 400)
          });

          finalUrl = res.request?.res?.responseUrl || extractedDownloadUrl;
          contentType = (res.headers['content-type'] || '').toLowerCase();
        }

        if (contentType.includes('text/html')) {
          throw new Error(
            'Girilen bağlantı doğrudan bir ZIP indirmesi değil, Google web giriş sayfası döndürdü. ' +
            'Lütfen tarayıcınızda (Chrome/Edge/Safari) indirmeyi bir kez başlatıp İndirilenler sayfasından (Ctrl+J veya Cmd+Option+L) ' +
            '"cURL Olarak Kopyala" (Copy as cURL) yapıp yapıştırın.'
          );
        }
      }

      // Content-Range: bytes 0-0/52428800000 -> Toplam boyutu yakala
      let totalSize = 0;
      const contentRange = res.headers['content-range'];
      if (contentRange) {
        const m = contentRange.match(/\/(\d+)$/);
        if (m) totalSize = parseInt(m[1], 10);
      }

      if (!totalSize && res.headers['content-length']) {
        totalSize = parseInt(res.headers['content-length'], 10);
      }

      const acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase();
      const supportsRange = res.status === 206 || acceptRanges.includes('bytes') || !!contentRange;

      if (!totalSize || totalSize <= 0) {
        throw new Error(
          'Arşiv dosya boyutu belirlenemedi (0 Bayt döndü). ' +
          'Bağlantının geçerli ve süresinin dolmamış olduğundan emin olun. ' +
          'Tarayıcınızın İndirilenler sayfasından güncel "Copy as cURL" komutunu yapıştırın.'
        );
      }

      if (!supportsRange) {
        throw new Error(
          'Hedef sunucu HTTP Range (kısmi içerik akışı) desteklemiyor. ' +
          'Google Takeout CDN canlı akış için Range desteği zorunludur. ' +
          'Lütfen doğrudan indirme CDN bağlantısını (takeout-download.usercontent.google.com) kullanın.'
        );
      }

      // Dosya adını belirle
      let filename = 'google-takeout.zip';
      const disposition = res.headers['content-disposition'];
      if (disposition) {
        const m = disposition.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
        if (m && m[1]) filename = decodeURIComponent(m[1]);
      } else {
        try {
          const urlObj = new URL(res.request?.res?.responseUrl || config.url);
          const base = path.basename(urlObj.pathname);
          if (base && base.endsWith('.zip')) filename = base;
        } catch (_) {}
      }

      return {
        success: true,
        finalUrl: res.request?.res?.responseUrl || config.url,
        headers: config.headers,
        filename,
        totalBytes: totalSize,
        totalSizeGb: (totalSize / (1024 * 1024 * 1024)).toFixed(2),
        supportsRange: true
      };
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 403)) {
        throw new Error('Google oturum çerezi geçersiz veya süresi dolmuş. Lütfen Takeout sayfasından güncel cURL komutunu kopyalayın.');
      }
      throw new Error(`Google Takeout doğrulama hatası: ${err.message}`);
    }
  }

  /**
   * Uzaktaki Google Takeout ZIP arşivini HTTP Range ile diske 1 bayt bile indirmeden
   * RAM üzerinde açar ve içindeki tüm fotoğrafları/videoları listeler.
   */
  static scanRemoteZip(validatedInfo, options = {}) {
    const pairLivePhotos = options.pairLivePhotos !== false;
    const { finalUrl, headers, totalBytes, filename } = validatedInfo;

    return new Promise((resolve, reject) => {
      class HttpRangeRandomAccessReader extends yauzl.RandomAccessReader {
        constructor() {
          super();
          this.cache = null; // { start, end, data: Buffer }
        }

        _readStreamForRange(start, end) {
          const passThrough = new PassThrough();

          // 1. Önbellek Kontrolü: İstenen bayt aralığı zaten RAM'deyse Google'a hiç gitme!
          if (this.cache && start >= this.cache.start && end <= this.cache.end) {
            const offsetStart = start - this.cache.start;
            const offsetEnd = end - this.cache.start;
            passThrough.end(this.cache.data.subarray(offsetStart, offsetEnd));
            return passThrough;
          }

          // 2. Read-Ahead (Önden 2 MB Blok Okuma): Central Directory okurken binlerce tekil HTTP isteğini önler
          const fetchSize = Math.max(end - start, 2 * 1024 * 1024);
          const fetchEnd = Math.min(start + fetchSize, totalBytes);
          const rangeHeader = `bytes=${start}-${fetchEnd - 1}`;

          axios.get(finalUrl, {
            headers: {
              ...headers,
              'Range': rangeHeader
            },
            responseType: 'arraybuffer',
            timeout: 60000
          }).then(response => {
            const buf = Buffer.from(response.data);
            this.cache = {
              start: start,
              end: start + buf.length,
              data: buf
            };

            const sliceEnd = Math.min(end - start, buf.length);
            passThrough.end(buf.subarray(0, sliceEnd));
          }).catch(err => {
            passThrough.emit('error', err);
          });

          return passThrough;
        }
      }

      const reader = new HttpRangeRandomAccessReader();

      yauzl.fromRandomAccessReader(reader, totalBytes, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
        if (err) return reject(err);

        const mediaEntries = [];
        const jsonEntries = new Map(); // entryName -> entry object (içeriği tarama sırasında indirilmez!)

        zipfile.readEntry();

        zipfile.on('entry', (entry) => {
          // Klasör ve macOS gizli dosyalarını atla
          if (/\/$/.test(entry.fileName) || entry.fileName.includes('__MACOSX') || path.basename(entry.fileName).startsWith('.')) {
            zipfile.readEntry();
            return;
          }

          const ext = path.extname(entry.fileName).toLowerCase();

          if (ext === '.json') {
            // Hızlı tarama: JSON içeriğini ağdan indirme, sadece dizin haritasına kaydet
            jsonEntries.set(entry.fileName, entry);
            jsonEntries.set(entry.fileName.toLowerCase(), entry);
            zipfile.readEntry();
          } else if (IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) {
            mediaEntries.push(entry);
            zipfile.readEntry();
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on('end', () => {
          const results = [];
          const pairedVideoEntries = new Set();
          const images = mediaEntries.filter(e => IMAGE_EXTENSIONS.has(path.extname(e.fileName).toLowerCase()));
          const videos = mediaEntries.filter(e => VIDEO_EXTENSIONS.has(path.extname(e.fileName).toLowerCase()));

          for (const img of images) {
            const imgExt = path.extname(img.fileName).toLowerCase();
            const imgStem = path.basename(img.fileName, imgExt);

            let matchingVideo = null;
            if (pairLivePhotos) {
              matchingVideo = videos.find(v => {
                const vidExt = path.extname(v.fileName).toLowerCase();
                const vidStem = path.basename(v.fileName, vidExt);
                return !pairedVideoEntries.has(v.fileName) && vidStem.toLowerCase() === imgStem.toLowerCase();
              });
            }

            const jsonEntry = jsonEntries.get(img.fileName + '.json') ||
                              jsonEntries.get(img.fileName.toLowerCase() + '.json') ||
                              jsonEntries.get(img.fileName.substring(0, img.fileName.length - imgExt.length) + '.json') ||
                              jsonEntries.get(img.fileName.substring(0, img.fileName.length - imgExt.length).toLowerCase() + '.json') ||
                              null;

            const item = {
              isCloudStream: true,
              isZip: true,
              cloudArchiveName: filename,
              zipPath: filename,
              fullPath: `cloud://${filename}#${img.fileName}`,
              entryName: img.fileName,
              name: path.basename(img.fileName),
              imageSize: img.uncompressedSize,
              size: img.uncompressedSize,
              mtime: img.getLastModDate(),
              ext: imgExt,
              jsonEntry,
              jsonContent: null,
              isLivePhoto: !!matchingVideo,
              livePhotoVideoEntry: matchingVideo ? matchingVideo.fileName : null,
              livePhotoVideoSize: matchingVideo ? matchingVideo.uncompressedSize : 0,
              livePhotoVideoName: matchingVideo ? path.basename(matchingVideo.fileName) : null,
              zipfile,
              entry: img,
              videoEntry: matchingVideo
            };

            if (matchingVideo) {
              pairedVideoEntries.add(matchingVideo.fileName);
              item.size += matchingVideo.uncompressedSize;
            }

            results.push(item);
          }

          // Tekil videolar
          for (const vid of videos) {
            if (!pairedVideoEntries.has(vid.fileName)) {
              const vidExt = path.extname(vid.fileName).toLowerCase();
              const jsonEntry = jsonEntries.get(vid.fileName + '.json') ||
                                jsonEntries.get(vid.fileName.toLowerCase() + '.json') ||
                                jsonEntries.get(vid.fileName.substring(0, vid.fileName.length - vidExt.length) + '.json') ||
                                jsonEntries.get(vid.fileName.substring(0, vid.fileName.length - vidExt.length).toLowerCase() + '.json') ||
                                null;

              results.push({
                isCloudStream: true,
                isZip: true,
                cloudArchiveName: filename,
                zipPath: filename,
                fullPath: `cloud://${filename}#${vid.fileName}`,
                entryName: vid.fileName,
                name: path.basename(vid.fileName),
                size: vid.uncompressedSize,
                mtime: vid.getLastModDate(),
                ext: vidExt,
                jsonEntry,
                jsonContent: null,
                isLivePhoto: false,
                zipfile,
                entry: vid
              });
            }
          }

          resolve(results);
        });

        zipfile.on('error', reject);
      });
    });
  }

  /**
   * İhtiyaç anında (yükleme sırasında) bir girdinin içeriğini string olarak okur
   */
  static readEntryContent(zipfile, entry) {
    return new Promise((resolve) => {
      if (!zipfile || !entry) return resolve(null);
      zipfile.openReadStream(entry, (err, stream) => {
        if (err) return resolve(null);
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', () => resolve(null));
      });
    });
  }

  /**
   * Buluttaki ZIP içindeki bir fotoğrafın stream nesnesini açar
   */
  static openCloudEntryStream(item, isVideoComponent = false) {
    const targetEntry = isVideoComponent ? item.videoEntry : item.entry;
    return new Promise((resolve, reject) => {
      if (!item.zipfile || !targetEntry) {
        return reject(new Error('Uzak ZIP arşivi veya girdi nesnesi bulunamadı.'));
      }
      item.zipfile.openReadStream(targetEntry, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }
}

module.exports = CloudTakeoutStreamer;
