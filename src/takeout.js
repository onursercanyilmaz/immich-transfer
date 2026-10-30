const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
  '.gif', '.dng', '.raw', '.cr2', '.nef', '.arw'
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'
]);

const ALL_MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS
]);

class ArchiveScanner {
  /**
   * Bir dizini, ZIP arşivlerini veya tekil bir ZIP dosyasını derinlemesine tarar.
   * Motion / Live Photo çiftlerini (.heic/.jpg + .mov/.mp4) otomatik gruplar.
   */
  static async scan(targetPath) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Hedef yol bulunamadı: ${targetPath}`);
    }

    const stat = fs.statSync(targetPath);
    if (stat.isFile() && targetPath.toLowerCase().endsWith('.zip')) {
      // Tekil ZIP dosyası
      return await this._scanZipFile(targetPath);
    }

    // Normal klasör (içinde loose dosyalar veya alt .zip dosyaları olabilir)
    return await this._scanFolder(targetPath);
  }

  /**
   * Standart klasör taraması (içindeki .zip arşivleri dahil)
   */
  static async _scanFolder(rootDir) {
    const rawFilesByDir = new Map(); // dirPath -> [ { fullPath, name, size, mtime, ext, stem } ]
    const zipFiles = [];

    function walk(currentDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (_) {
        return;
      }

      for (const entry of entries) {
        // Gizli sistem dosyalarını atla
        if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.zip') {
            zipFiles.push(fullPath);
          } else if (ALL_MEDIA_EXTENSIONS.has(ext)) {
            try {
              const fileStat = fs.statSync(fullPath);
              if (!rawFilesByDir.has(currentDir)) {
                rawFilesByDir.set(currentDir, []);
              }
              rawFilesByDir.get(currentDir).push({
                fullPath,
                name: entry.name,
                size: fileStat.size,
                mtime: fileStat.mtime,
                ext,
                stem: path.basename(entry.name, path.extname(entry.name))
              });
            } catch (_) {}
          }
        }
      }
    }

    walk(rootDir);

    // 1. Klasördeki loose medya dosyalarını işle ve Live Photo'ları eşleştir
    const results = [];
    for (const [dir, files] of rawFilesByDir.entries()) {
      const pairedVideos = new Set();

      // Önce Live Photo çiftlerini bul (Aynı klasörde aynı isimli Image + Video)
      const images = files.filter(f => IMAGE_EXTENSIONS.has(f.ext));
      const videos = files.filter(f => VIDEO_EXTENSIONS.has(f.ext));

      for (const img of images) {
        // İsim eşleşmesi (örn: IMG_001.HEIC + IMG_001.MOV veya IMG_001.JPG + IMG_001.MP4)
        const matchingVideo = videos.find(v => !pairedVideos.has(v.fullPath) && v.stem.toLowerCase() === img.stem.toLowerCase());

        const item = {
          isZip: false,
          fullPath: img.fullPath,
          name: img.name,
          imageSize: img.size,
          size: img.size,
          mtime: img.mtime,
          ext: img.ext,
          isLivePhoto: !!matchingVideo,
          livePhotoVideoPath: matchingVideo ? matchingVideo.fullPath : null,
          livePhotoVideoSize: matchingVideo ? matchingVideo.size : 0,
          livePhotoVideoName: matchingVideo ? matchingVideo.name : null
        };

        if (matchingVideo) {
          pairedVideos.add(matchingVideo.fullPath);
          item.size += matchingVideo.size; // Toplam aktarım boyutuna videoyu da ekle
        }

        results.push(item);
      }

      // Live photo çifti olmayan tekil videoları ekle
      for (const vid of videos) {
        if (!pairedVideos.has(vid.fullPath)) {
          results.push({
            isZip: false,
            fullPath: vid.fullPath,
            name: vid.name,
            size: vid.size,
            mtime: vid.mtime,
            ext: vid.ext,
            isLivePhoto: false
          });
        }
      }
    }

    // 2. Klasör içinde bulunan tüm .zip arşivlerini de doğrudan tara
    for (const zipPath of zipFiles) {
      try {
        const zipResults = await this._scanZipFile(zipPath);
        results.push(...zipResults);
      } catch (err) {
        console.error(`[ArchiveScanner] ZIP okuma hatası (${zipPath}):`, err.message);
      }
    }

    return results;
  }

  /**
   * ZIP dosyasını diske açmadan (zero-extraction) doğrudan içerisinden okur.
   */
  static _scanZipFile(zipPath) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
        if (err) return reject(err);

        const mediaEntries = [];
        const jsonSidecars = new Map(); // entryName -> raw json string

        zipfile.readEntry();

        zipfile.on('entry', (entry) => {
          // Klasör ve macOS çöp dosyalarını atla
          if (/\/$/.test(entry.fileName) || entry.fileName.includes('__MACOSX') || path.basename(entry.fileName).startsWith('.')) {
            zipfile.readEntry();
            return;
          }

          const ext = path.extname(entry.fileName).toLowerCase();

          if (ext === '.json') {
            // Küçük JSON yan dosyalarını bellek içinde oku
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) {
                zipfile.readEntry();
                return;
              }
              const chunks = [];
              readStream.on('data', chunk => chunks.push(chunk));
              readStream.on('end', () => {
                jsonSidecars.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
                zipfile.readEntry();
              });
              readStream.on('error', () => zipfile.readEntry());
            });
          } else if (ALL_MEDIA_EXTENSIONS.has(ext)) {
            mediaEntries.push(entry);
            zipfile.readEntry();
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on('end', () => {
          zipfile.close();

          // ZIP içindeki medyaları dizinlerine göre grupla ve Live Photo eşleştirmesi yap
          const results = [];
          const entriesByDir = new Map();

          for (const entry of mediaEntries) {
            const dir = path.dirname(entry.fileName);
            if (!entriesByDir.has(dir)) entriesByDir.set(dir, []);
            entriesByDir.get(dir).push(entry);
          }

          for (const [dir, entries] of entriesByDir.entries()) {
            const pairedVideoEntries = new Set();
            const images = entries.filter(e => IMAGE_EXTENSIONS.has(path.extname(e.fileName).toLowerCase()));
            const videos = entries.filter(e => VIDEO_EXTENSIONS.has(path.extname(e.fileName).toLowerCase()));

            for (const img of images) {
              const imgExt = path.extname(img.fileName).toLowerCase();
              const imgStem = path.basename(img.fileName, imgExt);

              const matchingVideo = videos.find(v => {
                const vidExt = path.extname(v.fileName).toLowerCase();
                const vidStem = path.basename(v.fileName, vidExt);
                return !pairedVideoEntries.has(v.fileName) && vidStem.toLowerCase() === imgStem.toLowerCase();
              });

              // JSON Sidecar eşleştir
              const jsonContent = ArchiveScanner._findZipJson(img.fileName, jsonSidecars);

              const item = {
                isZip: true,
                zipPath,
                fullPath: `${zipPath}#${img.fileName}`, // Checkpoint için benzersiz ID
                entryName: img.fileName,
                name: path.basename(img.fileName),
                imageSize: img.uncompressedSize,
                size: img.uncompressedSize,
                mtime: img.getLastModDate(),
                ext: imgExt,
                jsonContent,
                isLivePhoto: !!matchingVideo,
                livePhotoVideoEntry: matchingVideo ? matchingVideo.fileName : null,
                livePhotoVideoSize: matchingVideo ? matchingVideo.uncompressedSize : 0,
                livePhotoVideoName: matchingVideo ? path.basename(matchingVideo.fileName) : null
              };

              if (matchingVideo) {
                pairedVideoEntries.add(matchingVideo.fileName);
                item.size += matchingVideo.uncompressedSize;
              }

              results.push(item);
            }

            for (const vid of videos) {
              if (!pairedVideoEntries.has(vid.fileName)) {
                const vidExt = path.extname(vid.fileName).toLowerCase();
                const jsonContent = ArchiveScanner._findZipJson(vid.fileName, jsonSidecars);
                results.push({
                  isZip: true,
                  zipPath,
                  fullPath: `${zipPath}#${vid.fileName}`,
                  entryName: vid.fileName,
                  name: path.basename(vid.fileName),
                  size: vid.uncompressedSize,
                  mtime: vid.getLastModDate(),
                  ext: vidExt,
                  jsonContent,
                  isLivePhoto: false
                });
              }
            }
          }

          resolve(results);
        });

        zipfile.on('error', (err) => {
          zipfile.close();
          reject(err);
        });
      });
    });
  }

  /**
   * ZIP içindeki bir dosya için bellekten eşleşen JSON içeriğini bulur
   */
  static _findZipJson(entryFileName, jsonMap) {
    const dir = path.dirname(entryFileName);
    const filename = path.basename(entryFileName);
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);

    // 1. file.ext.json
    const c1 = dir === '.' ? `${filename}.json` : `${dir}/${filename}.json`;
    if (jsonMap.has(c1)) return jsonMap.get(c1);

    // 2. file.json
    const c2 = dir === '.' ? `${stem}.json` : `${dir}/${stem}.json`;
    if (jsonMap.has(c2)) return jsonMap.get(c2);

    // 3. Parantezli: file(1).jpg -> file.jpg(1).json
    if (stem.includes('(') && stem.endsWith(')')) {
      const idx = stem.lastIndexOf('(');
      const base = stem.substring(0, idx);
      const numPart = stem.substring(idx);
      const c3 = dir === '.' ? `${base}${ext}${numPart}.json` : `${dir}/${base}${ext}${numPart}.json`;
      if (jsonMap.has(c3)) return jsonMap.get(c3);
    }

    return null;
  }

  /**
   * ZIP içindeki bir girdinin canlı stream (akış) nesnesini döner
   */
  static openZipEntryStream(zipPath, entryName) {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (entry.fileName === entryName) {
            zipfile.openReadStream(entry, (err, stream) => {
              if (err) {
                zipfile.close();
                return reject(err);
              }
              // Stream bittiğinde veya hata aldığında zip dosya tanımlayıcısını kapat
              stream.on('end', () => zipfile.close());
              stream.on('error', () => zipfile.close());
              resolve(stream);
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on('end', () => {
          zipfile.close();
          reject(new Error(`ZIP içinde dosya bulunamadı: ${entryName}`));
        });

        zipfile.on('error', (err) => {
          zipfile.close();
          reject(err);
        });
      });
    });
  }

  /**
   * Medya meta verisini (.json veya EXIF/mtime) parse eder.
   */
  static parseMetadata(item) {
    const fallbackIso = (item.mtime || new Date()).toISOString();
    const result = {
      createdAt: fallbackIso,
      modifiedAt: fallbackIso,
      isFavorite: false,
      description: ''
    };

    let jsonString = item.jsonContent || null;

    // Eğer loose dosya ise diskten oku
    if (!jsonString && !item.isZip && item.fullPath) {
      const jsonPath = this._findDiskJsonPath(item.fullPath);
      if (jsonPath) {
        try {
          jsonString = fs.readFileSync(jsonPath, 'utf8');
        } catch (_) {}
      }
    }

    if (jsonString) {
      try {
        const data = JSON.parse(jsonString);
        const timestamp = data?.photoTakenTime?.timestamp;
        if (timestamp) {
          const date = new Date(parseInt(timestamp, 10) * 1000);
          if (!isNaN(date.getTime())) {
            result.createdAt = date.toISOString();
          }
        }
        if (data?.description) result.description = data.description;
        if (data?.favorited === true) result.isFavorite = true;
      } catch (_) {}
    }

    return result;
  }

  static _findDiskJsonPath(mediaPath) {
    const dir = path.dirname(mediaPath);
    const filename = path.basename(mediaPath);
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);

    const c1 = path.join(dir, `${filename}.json`);
    if (fs.existsSync(c1)) return c1;

    const c2 = path.join(dir, `${stem}.json`);
    if (fs.existsSync(c2)) return c2;

    if (stem.includes('(') && stem.endsWith(')')) {
      const idx = stem.lastIndexOf('(');
      const base = stem.substring(0, idx);
      const numPart = stem.substring(idx);
      const c3 = path.join(dir, `${base}${ext}${numPart}.json`);
      if (fs.existsSync(c3)) return c3;
    }

    if (filename.length > 45) {
      const prefix = filename.substring(0, 46);
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.startsWith(prefix) && file.endsWith('.json')) {
            return path.join(dir, file);
          }
        }
      } catch (_) {}
    }

    return null;
  }
}

module.exports = ArchiveScanner;
