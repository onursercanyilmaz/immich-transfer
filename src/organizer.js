const fs = require('fs');
const path = require('path');
const ArchiveScanner = require('./takeout');

class MediaOrganizer {
  /**
   * @param {string} baseOutputDir - Sınıflandırma ana hedef dizini (içinde uploaded, duplicates, errors oluşur)
   * @param {object} options - { action: 'move' | 'copy', enabled: boolean }
   */
  constructor(baseOutputDir, options = {}) {
    this.baseOutputDir = baseOutputDir;
    this.action = options.action === 'copy' ? 'copy' : 'move'; // 'move' (varsayılan) veya 'copy'
    this.enabled = options.enabled !== false;
  }

  /**
   * Dosya adı çakışmalarını önleyen benzersiz yol üretici
   * örn: photo.jpg -> photo (1).jpg
   */
  static getUniqueFilePath(destDir, filename) {
    let target = path.join(destDir, filename);
    if (!fs.existsSync(target)) return target;

    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);
    let counter = 1;

    while (fs.existsSync(target)) {
      target = path.join(destDir, `${stem} (${counter})${ext}`);
      counter++;
    }
    return target;
  }

  /**
   * Dosyayı taşır (move) veya kopyalar (copy).
   * Farklı disk birimleri (cross-device EXDEV) durumunu güvenle yönetir.
   */
  static moveOrCopy(srcPath, destPath, action = 'move') {
    if (!fs.existsSync(srcPath)) return false;

    if (action === 'move') {
      try {
        fs.renameSync(srcPath, destPath);
        return true;
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Farklı disk veya dosya sistemi (ör. harici SSD'den dahili diske)
          fs.copyFileSync(srcPath, destPath);
          fs.unlinkSync(srcPath);
          return true;
        }
        throw err;
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
      return true;
    }
  }

  /**
   * ZIP içindeki bir girdiyi hedef diske stream ederek kaydeder
   */
  static async extractZipEntry(zipPath, entryName, destPath) {
    const stream = await ArchiveScanner.openZipEntryStream(zipPath, entryName);
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      stream.pipe(out);
      out.on('finish', () => resolve(true));
      out.on('error', reject);
      stream.on('error', reject);
    });
  }

  /**
   * Medya öğesini ve tüm yan bileşenlerini (JSON, Live Photo video, Hata raporu)
   * ilgili kategoriye ('uploaded', 'duplicates', 'errors') taşır veya çıkarır.
   *
   * @param {object} item - Medya öğesi nesnesi
   * @param {'uploaded' | 'duplicates' | 'errors'} category - Hedef kategori
   * @param {string|null} errorDetails - Varsa hata mesajı
   */
  async organize(item, category, errorDetails = null) {
    if (!this.enabled || !this.baseOutputDir) return null;

    const categoryDir = path.join(this.baseOutputDir, category);
    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const results = {
      category,
      primaryFile: null,
      companionVideo: null,
      sidecarJson: null,
      errorLog: null
    };

    try {
      // 1. Ana Medya Dosyası
      const destMedia = MediaOrganizer.getUniqueFilePath(categoryDir, item.name);

      if (item.isZip) {
        // ZIP dosyası içinden doğrudan hedef kategoriye çıkar
        await MediaOrganizer.extractZipEntry(item.zipPath, item.entryName, destMedia);
      } else if (item.fullPath && fs.existsSync(item.fullPath)) {
        // Diskteki normal dosya: taşı veya kopyala
        MediaOrganizer.moveOrCopy(item.fullPath, destMedia, this.action);
      }
      results.primaryFile = destMedia;

      // 2. Canlı / Hareketli Fotoğraf (Live Photo) Videosu
      if (item.isLivePhoto) {
        const vidName = item.livePhotoVideoName || 'motion.mov';
        const destVid = MediaOrganizer.getUniqueFilePath(categoryDir, vidName);

        if (item.isZip && item.livePhotoVideoEntry) {
          await MediaOrganizer.extractZipEntry(item.zipPath, item.livePhotoVideoEntry, destVid);
          results.companionVideo = destVid;
        } else if (item.livePhotoVideoPath && fs.existsSync(item.livePhotoVideoPath)) {
          MediaOrganizer.moveOrCopy(item.livePhotoVideoPath, destVid, this.action);
          results.companionVideo = destVid;
        }
      }

      // 3. Google Takeout JSON Yan Dosyası
      if (item.isZip) {
        if (item.jsonContent) {
          const destJson = path.join(categoryDir, `${item.name}.json`);
          fs.writeFileSync(destJson, item.jsonContent, 'utf8');
          results.sidecarJson = destJson;
        }
      } else if (item.fullPath) {
        const jsonDiskPath = ArchiveScanner._findDiskJsonPath(item.fullPath);
        if (jsonDiskPath && fs.existsSync(jsonDiskPath)) {
          const destJson = path.join(categoryDir, path.basename(jsonDiskPath));
          MediaOrganizer.moveOrCopy(jsonDiskPath, destJson, this.action);
          results.sidecarJson = destJson;
        }
      }

      // 4. Hata Kaydı (errors klasörü için açıklama dosyası)
      if (category === 'errors' && errorDetails) {
        const errorFileName = `${item.name}.error.txt`;
        const destErrorLog = path.join(categoryDir, errorFileName);
        const report = [
          `=========================================`,
          `IMMICH TRANSFER HATALI DOSYA RAPORU`,
          `=========================================`,
          `Dosya Adı:   ${item.name}`,
          `Kaynak:      ${item.fullPath || item.zipPath + '#' + item.entryName}`,
          `Boyut:       ${(item.size / (1024 * 1024)).toFixed(2)} MB (${item.size} bytes)`,
          `Tarih/Saat:  ${new Date().toISOString()}`,
          `Hata Nedeni: ${errorDetails}`,
          `=========================================`,
          `Olası Çözümler:`,
          `- Dosya boyutu büyükse reverse proxy (Nginx/Cloudflare) limitlerini kontrol edin.`,
          `- Format bozuksa VLC veya fotoğraf görüntüleyici ile kontrol edin.`,
          `- Sunucu loglarını incelemek için: docker logs immich_server`,
          `=========================================`
        ].join('\n');

        fs.writeFileSync(destErrorLog, report, 'utf8');
        results.errorLog = destErrorLog;
      }

      return results;
    } catch (err) {
      console.error(`[MediaOrganizer] Hata (${item.name} -> ${category}):`, err.message);
      return null;
    }
  }
}

module.exports = MediaOrganizer;
