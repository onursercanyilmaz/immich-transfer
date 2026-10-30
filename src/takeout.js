const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const exifr = require('exifr');

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
   * @param {string} targetPath - Hedef dizin veya tekil .zip yolu
   * @param {object} options - { scanExtracted: true, scanZips: true, pairLivePhotos: true }
   */
  static async scan(targetPath, options = {}) {
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Hedef yol bulunamadı: ${targetPath}`);
    }

    const scanExtracted = options.scanExtracted !== false;
    const scanZips = options.scanZips !== false;
    const pairLivePhotos = options.pairLivePhotos !== false;

    const stat = fs.statSync(targetPath);
    if (stat.isFile() && targetPath.toLowerCase().endsWith('.zip')) {
      if (!scanZips) return [];
      // Tekil ZIP dosyası
      return await this._scanZipFile(targetPath, { pairLivePhotos });
    }

    // Normal klasör (içinde loose dosyalar veya alt .zip dosyaları olabilir)
    return await this._scanFolder(targetPath, { scanExtracted, scanZips, pairLivePhotos });
  }

  /**
   * Standart klasör taraması (içindeki .zip arşivleri dahil)
   */
  static async _scanFolder(rootDir, options = {}) {
    const scanExtracted = options.scanExtracted !== false;
    const scanZips = options.scanZips !== false;
    const pairLivePhotos = options.pairLivePhotos !== false;

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
            if (scanZips) {
              zipFiles.push(fullPath);
            }
          } else if (scanExtracted && ALL_MEDIA_EXTENSIONS.has(ext)) {
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

    const results = [];

    // 1. Klasördeki loose medya dosyalarını işle
    if (scanExtracted) {
      for (const [dir, files] of rawFilesByDir.entries()) {
        const pairedVideos = new Set();
        const images = files.filter(f => IMAGE_EXTENSIONS.has(f.ext));
        const videos = files.filter(f => VIDEO_EXTENSIONS.has(f.ext));

        for (const img of images) {
          let matchingVideo = null;
          if (pairLivePhotos) {
            matchingVideo = videos.find(v => !pairedVideos.has(v.fullPath) && v.stem.toLowerCase() === img.stem.toLowerCase());
          }

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
    }

    // 2. Klasör içinde bulunan tüm .zip arşivlerini de doğrudan tara
    if (scanZips) {
      for (const zipPath of zipFiles) {
        try {
          const zipResults = await this._scanZipFile(zipPath, { pairLivePhotos });
          results.push(...zipResults);
        } catch (err) {
          console.error(`[ArchiveScanner] ZIP okuma hatası (${zipPath}):`, err.message);
        }
      }
    }

    return results;
  }

  /**
   * ZIP dosyasını diske açmadan (zero-extraction) doğrudan içerisinden okur.
   */
  static _scanZipFile(zipPath, options = {}) {
    const pairLivePhotos = options.pairLivePhotos !== false;
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
                const content = Buffer.concat(chunks).toString('utf8');
                jsonSidecars.set(entry.fileName, content);
                jsonSidecars.set(entry.fileName.toLowerCase(), content);
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

              let matchingVideo = null;
              if (pairLivePhotos) {
                matchingVideo = videos.find(v => {
                  const vidExt = path.extname(v.fileName).toLowerCase();
                  const vidStem = path.basename(v.fileName, vidExt);
                  return !pairedVideoEntries.has(v.fileName) && vidStem.toLowerCase() === imgStem.toLowerCase();
                });
              }

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

    const candidates = [
      `${filename}.json`,
      `${stem}.json`,
      `${filename}.supplemental-metadata.json`,
      `${stem}.supplemental-metadata.json`
    ];

    if (stem.includes('(') && stem.endsWith(')')) {
      const idx = stem.lastIndexOf('(');
      const base = stem.substring(0, idx);
      const numPart = stem.substring(idx);
      candidates.push(`${base}${ext}${numPart}.json`);
      candidates.push(`${base}${numPart}.json`);
      candidates.push(`${base}${numPart}${ext}.json`);
      candidates.push(`${base}${ext}.json${numPart}`);
    }

    if (stem.toLowerCase().endsWith('-edited') || stem.toLowerCase().endsWith('-düzenlendi')) {
      const originalStem = stem.replace(/-(?:edited|d[uü]zenlendi)$/i, '');
      candidates.push(`${originalStem}${ext}.json`);
      candidates.push(`${originalStem}.json`);
      candidates.push(`${originalStem}.supplemental-metadata.json`);
    }

    // 1. Doğrudan ve küçük harf eşleme
    for (const c of candidates) {
      const full = dir === '.' ? c : `${dir}/${c}`;
      if (jsonMap.has(full)) return jsonMap.get(full);
      if (jsonMap.has(full.toLowerCase())) return jsonMap.get(full.toLowerCase());
    }

    // 2. Kırpılmış (Truncated) ZIP içi JSON eşleme (>35 karakter)
    if (stem.length > 35) {
      const prefix = (dir === '.' ? stem.substring(0, 36) : `${dir}/${stem.substring(0, 36)}`).toLowerCase();
      for (const [key, content] of jsonMap.entries()) {
        if (key.startsWith(prefix) && key.endsWith('.json')) {
          return content;
        }
      }
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
   * ZIP içindeki bir dosyanın başından (EXIF için) ilk maxBytes kadarını okur
   */
  static _readZipEntryHeader(zipPath, entryName, maxBytes = 65536) {
    return new Promise((resolve) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return resolve(null);

        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (entry.fileName === entryName) {
            zipfile.openReadStream(entry, (err, stream) => {
              if (err || !stream) {
                zipfile.close();
                return resolve(null);
              }
              const chunks = [];
              let total = 0;
              stream.on('data', (chunk) => {
                chunks.push(chunk);
                total += chunk.length;
                if (total >= maxBytes) {
                  try { stream.destroy(); } catch (_) {}
                  try { zipfile.close(); } catch (_) {}
                  resolve(Buffer.concat(chunks).subarray(0, maxBytes));
                }
              });
              stream.on('end', () => {
                try { zipfile.close(); } catch (_) {}
                resolve(Buffer.concat(chunks));
              });
              stream.on('error', () => {
                try { zipfile.close(); } catch (_) {}
                resolve(null);
              });
            });
          } else {
            zipfile.readEntry();
          }
        });

        zipfile.on('end', () => {
          try { zipfile.close(); } catch (_) {}
          resolve(null);
        });

        zipfile.on('error', () => {
          try { zipfile.close(); } catch (_) {}
          resolve(null);
        });
      });
    });
  }

  /**
   * Dosya adından akıllı tarih ayıklama (Kamera, WhatsApp, Signal, Ekran görüntüsü formatları)
   */
  static extractDateFromFilename(name) {
    if (!name || typeof name !== 'string') return null;

    // 1. YYYYMMDD_HHMMSS or YYYYMMDD-HHMMSS (e.g. IMG_20220815_143022, PXL_20230412_123456, VID_20210520_192010)
    let m = name.match(/(?:IMG_|VID_|PXL_|PHOTO_|DSC_|PIC_)?(20\d\d|19\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])[_-]([01]\d|2[0-3])([0-5]\d)([0-5]\d)/i);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      if (!isNaN(d.getTime())) return d;
    }

    // 2. YYYY-MM-DD[-_ ]HH.MM.SS (e.g. 2023-04-12 18.25.10, Screenshot_2022-03-15-10-20-30)
    m = name.match(/(20\d\d|19\d\d)[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])[-_ ]([01]\d|2[0-3])[-_.:]([0-5]\d)[-_.:]([0-5]\d)/);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      if (!isNaN(d.getTime())) return d;
    }

    // 3. YYYY-MM-DD or YYYYMMDD without time (e.g. IMG-20230514-WA0002, WP_20190820, 2022-08-15)
    m = name.match(/(?:WA|WP|IMG|VID|PHOTO)?[-_]?(20\d\d|19\d\d)[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])/i);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0));
      if (!isNaN(d.getTime())) return d;
    }

    // 4. 13 basamaklı Epoch milisaniye timestamp (e.g. 1622505600123.jpg)
    m = name.match(/\b(1[4-7]\d{11})\b/);
    if (m) {
      const d = new Date(parseInt(m[1], 10));
      if (!isNaN(d.getTime())) return d;
    }

    // 5. 10 basamaklı Epoch saniye timestamp (e.g. 1622505600.jpg)
    m = name.match(/\b(1[4-7]\d{8})\b/);
    if (m) {
      const d = new Date(parseInt(m[1], 10) * 1000);
      if (!isNaN(d.getTime())) return d;
    }

    return null;
  }

  /**
   * Medya meta verisini (JSON yan dosyası, gömülü EXIF / QuickTime veya dosya adı tarihinden)
   * akıllı ve çok aşamalı öncelik sırasıyla parse eder.
   */
  static async parseMetadata(item) {
    let createdAt = null;
    let description = '';
    let isFavorite = false;
    let dateFound = false;

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

    // --- 1. AŞAMA: Google Takeout JSON Yan Dosyası ---
    if (jsonString) {
      try {
        const data = JSON.parse(jsonString);
        let parsedDate = null;

        // a) photoTakenTime.timestamp
        const ptt = data?.photoTakenTime?.timestamp;
        if (ptt && ptt !== '0' && ptt !== 0) {
          const d = new Date(parseInt(ptt, 10) * 1000);
          if (!isNaN(d.getTime()) && d.getFullYear() > 1970) parsedDate = d;
        }

        // b) photoTakenTime.formatted
        if (!parsedDate && data?.photoTakenTime?.formatted) {
          const d = new Date(data.photoTakenTime.formatted);
          if (!isNaN(d.getTime()) && d.getFullYear() > 1970) parsedDate = d;
        }

        // c) creationTime.timestamp
        if (!parsedDate) {
          const ct = data?.creationTime?.timestamp;
          if (ct && ct !== '0' && ct !== 0) {
            const d = new Date(parseInt(ct, 10) * 1000);
            if (!isNaN(d.getTime()) && d.getFullYear() > 1970) parsedDate = d;
          }
        }

        // d) creationTime.formatted
        if (!parsedDate && data?.creationTime?.formatted) {
          const d = new Date(data.creationTime.formatted);
          if (!isNaN(d.getTime()) && d.getFullYear() > 1970) parsedDate = d;
        }

        // e) modificationTime.timestamp
        if (!parsedDate) {
          const mt = data?.modificationTime?.timestamp;
          if (mt && mt !== '0' && mt !== 0) {
            const d = new Date(parseInt(mt, 10) * 1000);
            if (!isNaN(d.getTime()) && d.getFullYear() > 1970) parsedDate = d;
          }
        }

        if (parsedDate) {
          createdAt = parsedDate.toISOString();
          dateFound = true;
        }

        if (data?.description) description = data.description;
        if (data?.favorited === true) isFavorite = true;
      } catch (_) {}
    }

    // --- 2. AŞAMA: Gömülü EXIF / QuickTime Meta Verisi (exifr) ---
    if (!dateFound) {
      try {
        let exifData = null;
        if (!item.isZip && item.fullPath && fs.existsSync(item.fullPath)) {
          exifData = await exifr.parse(item.fullPath, ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'creationDate']);
        } else if (item.isZip && item.zipPath && item.entryName) {
          const headerChunk = await ArchiveScanner._readZipEntryHeader(item.zipPath, item.entryName, 65536);
          if (headerChunk && headerChunk.length > 0) {
            exifData = await exifr.parse(headerChunk, ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'creationDate']);
          }
        }

        if (exifData) {
          const exifDate = exifData.DateTimeOriginal || exifData.CreateDate || exifData.creationDate || exifData.ModifyDate;
          if (exifDate instanceof Date && !isNaN(exifDate.getTime()) && exifDate.getFullYear() > 1970) {
            createdAt = exifDate.toISOString();
            dateFound = true;
          }
        }
      } catch (_) {}
    }

    // --- 3. AŞAMA: Dosya Adından Akıllı Tarih Ayıklama (Regex) ---
    // Örn: IMG_20220815_143022.jpg, PXL_20230412, IMG-20230514-WA0002, 2021-09-04
    if (!dateFound && item.name) {
      const filenameDate = ArchiveScanner.extractDateFromFilename(item.name);
      if (filenameDate) {
        createdAt = filenameDate.toISOString();
        dateFound = true;
      }
    }

    // --- 4. AŞAMA: Dosya Sistemi mtime (Yalnızca geçmiş bir tarihse) ---
    if (!dateFound && item.mtime) {
      const mDate = new Date(item.mtime);
      if (!isNaN(mDate.getTime()) && mDate.getFullYear() > 1970) {
        createdAt = mDate.toISOString();
      }
    }

    // Nihai güvence
    const finalIso = createdAt || new Date().toISOString();
    return {
      createdAt: finalIso,
      modifiedAt: finalIso,
      isFavorite,
      description
    };
  }

  static _findDiskJsonPath(mediaPath) {
    const dir = path.dirname(mediaPath);
    const filename = path.basename(mediaPath);
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);

    const candidates = [
      `${filename}.json`,
      `${stem}.json`,
      `${filename}.supplemental-metadata.json`,
      `${stem}.supplemental-metadata.json`
    ];

    if (stem.includes('(') && stem.endsWith(')')) {
      const idx = stem.lastIndexOf('(');
      const base = stem.substring(0, idx);
      const numPart = stem.substring(idx);
      candidates.push(`${base}${ext}${numPart}.json`);
      candidates.push(`${base}${numPart}.json`);
      candidates.push(`${base}${numPart}${ext}.json`);
      candidates.push(`${base}${ext}.json${numPart}`);
    }

    if (stem.toLowerCase().endsWith('-edited') || stem.toLowerCase().endsWith('-düzenlendi')) {
      const originalStem = stem.replace(/-(?:edited|d[uü]zenlendi)$/i, '');
      candidates.push(`${originalStem}${ext}.json`);
      candidates.push(`${originalStem}.json`);
      candidates.push(`${originalStem}.supplemental-metadata.json`);
    }

    // 1. Doğrudan dosya varlığı kontrolü
    for (const c of candidates) {
      const full = path.join(dir, c);
      if (fs.existsSync(full)) return full;
    }

    // 2. Büyük/küçük harf duyarsız ve kırpılmış isim arama
    try {
      const files = fs.readdirSync(dir);
      const filesLower = new Map();
      for (const f of files) {
        filesLower.set(f.toLowerCase(), f);
      }

      for (const c of candidates) {
        const lower = c.toLowerCase();
        if (filesLower.has(lower)) {
          return path.join(dir, filesLower.get(lower));
        }
      }

      // Google Takeout 46-51 karakter uzun dosya adı kırpması
      if (stem.length > 35) {
        const prefix = stem.substring(0, 36).toLowerCase();
        for (const [fLower, fOriginal] of filesLower.entries()) {
          if (fLower.startsWith(prefix) && fLower.endsWith('.json')) {
            return path.join(dir, fOriginal);
          }
        }
      }
    } catch (_) {}

    return null;
  }
}

module.exports = ArchiveScanner;
