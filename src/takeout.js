const fs = require('fs');
const path = require('path');

const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif',
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm',
  '.gif', '.dng', '.raw', '.cr2', '.nef', '.arw'
]);

class TakeoutScanner {
  static scanDirectory(rootDir) {
    const results = [];

    function walk(currentDir) {
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (err) {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.has(ext)) {
            try {
              const stat = fs.statSync(fullPath);
              results.push({
                fullPath,
                name: entry.name,
                size: stat.size,
                mtime: stat.mtime
              });
            } catch (_) {}
          }
        }
      }
    }

    walk(rootDir);
    return results;
  }

  static findJsonPath(mediaPath) {
    const dir = path.dirname(mediaPath);
    const filename = path.basename(mediaPath);
    const ext = path.extname(filename);
    const stem = path.basename(filename, ext);

    // 1. dosya.uzantı.json (örn: photo.jpg.json)
    const c1 = path.join(dir, `${filename}.json`);
    if (fs.existsSync(c1)) return c1;

    // 2. dosya.json (örn: photo.json)
    const c2 = path.join(dir, `${stem}.json`);
    if (fs.existsSync(c2)) return c2;

    // 3. Parantezli kopyalar: photo(1).jpg -> photo.jpg(1).json
    if (stem.includes('(') && stem.endsWith(')')) {
      const idx = stem.lastIndexOf('(');
      const base = stem.substring(0, idx);
      const numPart = stem.substring(idx);
      const c3 = path.join(dir, `${base}${ext}${numPart}.json`);
      if (fs.existsSync(c3)) return c3;
    }

    // 4. Kırpılmış (truncated) isimler (Takeout ~46-51 karakterde kesebilir)
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

  static parseMetadata(mediaPath, mtime) {
    const fallbackIso = (mtime || new Date()).toISOString();
    const result = {
      createdAt: fallbackIso,
      modifiedAt: fallbackIso,
      isFavorite: false,
      description: ''
    };

    const jsonPath = this.findJsonPath(mediaPath);
    if (!jsonPath) return result;

    try {
      const content = fs.readFileSync(jsonPath, 'utf8');
      const data = JSON.parse(content);

      const timestamp = data?.photoTakenTime?.timestamp;
      if (timestamp) {
        const date = new Date(parseInt(timestamp, 10) * 1000);
        if (!isNaN(date.getTime())) {
          result.createdAt = date.toISOString();
        }
      }

      if (data?.description) {
        result.description = data.description;
      }

      if (data?.favorited === true) {
        result.isFavorite = true;
      }
    } catch (_) {}

    return result;
  }
}

module.exports = TakeoutScanner;
