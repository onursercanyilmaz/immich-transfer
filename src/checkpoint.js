const fs = require('fs');
const path = require('path');

class CheckpointManager {
  constructor(dataDir) {
    this.dataDir = dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.checkpointFile = path.join(this.dataDir, 'checkpoint.jsonl');
    this.logFile = path.join(this.dataDir, 'transfer.log');
    this.uploadedSet = new Set();
    this.stats = { success: 0, duplicate: 0, error: 0 };
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.checkpointFile)) return;
    try {
      const content = fs.readFileSync(this.checkpointFile, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.status === 'SUCCESS' || entry.status === 'DUPLICATE') {
            this.uploadedSet.add(entry.filePath);
            if (entry.status === 'SUCCESS') this.stats.success++;
            if (entry.status === 'DUPLICATE') this.stats.duplicate++;
          } else if (entry.status === 'ERROR') {
            this.stats.error++;
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error('[Checkpoint] Yükleme hatası:', err.message);
    }
  }

  isUploaded(filePath) {
    return this.uploadedSet.has(filePath);
  }

  record(filePath, fileSize, status, immichId = '', errorMsg = '') {
    const entry = {
      filePath,
      fileSize,
      status,
      immichId,
      errorMsg,
      timestamp: new Date().toISOString()
    };

    if (status === 'SUCCESS' || status === 'DUPLICATE') {
      this.uploadedSet.add(filePath);
      if (status === 'SUCCESS') this.stats.success++;
      if (status === 'DUPLICATE') this.stats.duplicate++;
    } else {
      this.stats.error++;
    }

    const line = JSON.stringify(entry) + '\n';
    try {
      const fd = fs.openSync(this.checkpointFile, 'a');
      fs.writeSync(fd, line);
      fs.fsyncSync(fd); // OS önbelleğini diske anında yaz (Crash koruması)
      fs.closeSync(fd);
    } catch (err) {
      console.error('[Checkpoint] Diske yazma hatası:', err.message);
    }
  }

  log(level, message) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `[${now}] [${level.toUpperCase().padEnd(7)}] ${message}\n`;
    try {
      const fd = fs.openSync(this.logFile, 'a');
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (_) {}
  }
}

module.exports = CheckpointManager;
