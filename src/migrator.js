const EventEmitter = require('events');
const ImmichClient = require('./immich');
const TakeoutScanner = require('./takeout');
const CheckpointManager = require('./checkpoint');

class Migrator extends EventEmitter {
  constructor(checkpointManager) {
    super();
    this.checkpoint = checkpointManager;
    this.state = 'IDLE'; // IDLE, SCANNING, RUNNING, PAUSED, COMPLETED, STOPPED
    this.config = null;
    this.client = null;
    this.filesToProcess = [];
    this.activeWorkers = new Map(); // id -> filename

    this.stats = {
      totalFiles: 0,
      scannedFiles: 0,
      extractedCount: 0,
      zipCount: 0,
      livePhotoCount: 0,
      alreadyUploaded: 0,
      pendingFiles: 0,
      processedFiles: 0,
      successCount: 0,
      duplicateCount: 0,
      errorCount: 0,
      totalBytes: 0,
      uploadedBytes: 0,
      speedBytesPerSec: 0,
      etaSeconds: 0,
      percentage: 0
    };

    this.logs = [];
    this.isPaused = false;
    this.isStopped = false;
    this.speedSampleTimer = null;
    this.lastUploadedBytes = 0;

    // Paralel yükleme sırasında aynı dosyanın mükerrer yüklenmesini önleyen in-flight mutex & parmak izi seti
    this.inFlightAssets = new Set();
    this.completedFingerprints = new Set();
  }

  log(level, message) {
    const entry = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toLocaleTimeString(),
      level: level.toUpperCase(),
      message
    };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();

    this.checkpoint.log(level, message);
    this.emit('log', entry);
  }

  async testConnection(url, apiKey) {
    const client = new ImmichClient(url, apiKey);
    const user = await client.getCurrentUser();
    return user;
  }

  async scan(takeoutDir, options = {}) {
    this.state = 'SCANNING';
    this.emit('status', { state: this.state });

    const scanExtracted = options.scanExtracted !== false;
    const scanZips = options.scanZips !== false;
    const pairLivePhotos = options.pairLivePhotos !== false;

    this.log('INFO', `Arşiv taranıyor: ${takeoutDir} (Klasör: ${scanExtracted ? 'Açık' : 'Kapalı'}, ZIP: ${scanZips ? 'Açık' : 'Kapalı'}, Live Photo: ${pairLivePhotos ? 'Açık' : 'Kapalı'})`);

    const allFiles = await TakeoutScanner.scan(takeoutDir, { scanExtracted, scanZips, pairLivePhotos });
    this.stats.totalFiles = allFiles.length;
    this.stats.scannedFiles = allFiles.length;

    let extractedCount = 0;
    let zipCount = 0;
    let livePhotoCount = 0;

    for (const f of allFiles) {
      if (f.isZip) {
        zipCount++;
      } else {
        extractedCount++;
      }
      if (f.isLivePhoto) {
        livePhotoCount++;
      }
    }

    this.stats.extractedCount = extractedCount;
    this.stats.zipCount = zipCount;
    this.stats.livePhotoCount = livePhotoCount;

    this.filesToProcess = [];
    let alreadyUploaded = 0;
    let totalBytes = 0;

    for (const f of allFiles) {
      if (this.checkpoint.isUploaded(f.fullPath)) {
        alreadyUploaded++;
      } else {
        this.filesToProcess.push(f);
        totalBytes += f.size;
      }
    }

    this.stats.alreadyUploaded = alreadyUploaded;
    this.stats.pendingFiles = this.filesToProcess.length;
    this.stats.totalBytes = totalBytes;
    this.stats.uploadedBytes = 0;
    this.stats.processedFiles = 0;
    this.stats.percentage = this.stats.pendingFiles === 0 ? 100 : 0;

    this.log('INFO', `Tarama tamamlandı: ${allFiles.length} medya (${extractedCount} normal dosya, ${zipCount} ZIP içi, ${livePhotoCount} Live Photo). ${alreadyUploaded} önceden yüklenmiş, ${this.filesToProcess.length} yeni dosya yüklenecek.`);
    this.state = 'READY';
    this.emit('status', { state: this.state, stats: this.stats });
    return this.stats;
  }

  async start(config) {
    if (this.state === 'RUNNING') return;
    this.config = config;
    this.client = new ImmichClient(config.immichUrl, config.apiKey);
    this.concurrency = parseInt(config.concurrency, 10) || 4;
    this.isPaused = false;
    this.isStopped = false;

    // Eğer henüz taranmadıysa veya beklemede dosya yoksa, önce tara
    if (this.filesToProcess.length === 0 && this.stats.totalFiles === 0) {
      await this.scan(config.takeoutDir, {
        scanExtracted: config.scanExtracted !== false,
        scanZips: config.scanZips !== false,
        pairLivePhotos: config.pairLivePhotos !== false
      });
    }

    this.state = 'RUNNING';
    this.log('INFO', `Aktarım başlatıldı. Paralellik (Concurrency): ${this.concurrency}`);
    this.emit('status', { state: this.state });

    // Hız ve ETA hesaplayıcı
    this.lastUploadedBytes = 0;
    this.speedSampleTimer = setInterval(() => {
      if (this.state === 'RUNNING' && !this.isPaused) {
        const delta = this.stats.uploadedBytes - this.lastUploadedBytes;
        this.lastUploadedBytes = this.stats.uploadedBytes;
        this.stats.speedBytesPerSec = delta; // Her 1 saniyede artan byte

        const remainingBytes = Math.max(0, this.stats.totalBytes - this.stats.uploadedBytes);
        this.stats.etaSeconds = delta > 0 ? Math.round(remainingBytes / delta) : 0;
        this.emit('progress', this.stats);
      }
    }, 1000);

    this._runPool();
  }

  pause() {
    this.isPaused = true;
    this.state = 'PAUSED';
    this.log('WARN', 'Aktarım duraklatıldı.');
    this.emit('status', { state: this.state });
  }

  resume() {
    this.isPaused = false;
    this.state = 'RUNNING';
    this.log('INFO', 'Aktarım devam ettiriliyor.');
    this.emit('status', { state: this.state });
    this._runPool();
  }

  stop() {
    this.isStopped = true;
    this.state = 'STOPPED';
    if (this.speedSampleTimer) clearInterval(this.speedSampleTimer);
    this.log('WARN', 'Aktarım kullanıcı tarafından durduruldu.');
    this.emit('status', { state: this.state });
  }

  async _runPool() {
    let index = 0;
    const workerPromises = [];

    const getNextItem = () => {
      if (this.isStopped || index >= this.filesToProcess.length) return null;
      return this.filesToProcess[index++];
    };

    const worker = async (workerId) => {
      while (!this.isStopped) {
        while (this.isPaused && !this.isStopped) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (this.isStopped) break;

        const item = getNextItem();
        if (!item) break;

        this.activeWorkers.set(workerId, item.name);
        this.emit('workers', Array.from(this.activeWorkers.values()));

        const meta = TakeoutScanner.parseMetadata(item);

        // --- PARALEL MÜKERRER (DUPLICATE) ENGELLEME KORUMASI ---
        const assetFingerprint = `${item.name}_${item.size}_${meta.createdAt}`;

        if (this.completedFingerprints.has(assetFingerprint) || this.inFlightAssets.has(assetFingerprint)) {
          this.stats.duplicateCount++;
          this.stats.processedFiles++;
          this.stats.uploadedBytes += item.size;
          if (this.stats.totalBytes > 0) {
            this.stats.percentage = Math.min(100, Math.round((this.stats.uploadedBytes / this.stats.totalBytes) * 100));
          }
          this.checkpoint.record(item.fullPath, item.size, 'DUPLICATE', '', 'Paralel kopya atlandı');
          this.log('SKIP', `Paralel kopya tespit edildi, ağ harcanmadan atlandı: ${item.name}`);
          this.emit('progress', this.stats);
          continue;
        }

        // Dosyayı aktif yükleme havuzuna (in-flight) kilitle
        this.inFlightAssets.add(assetFingerprint);

        let fileUploadedBytes = 0;
        const onProgress = (chunkLen) => {
          fileUploadedBytes += chunkLen;
          this.stats.uploadedBytes += chunkLen;
          if (this.stats.totalBytes > 0) {
            this.stats.percentage = Math.min(100, Math.round((this.stats.uploadedBytes / this.stats.totalBytes) * 100));
          }
          this.emit('progress', this.stats);
        };

        let result;
        try {
          result = await this.client.uploadAsset(item, meta, onProgress);
        } finally {
          this.inFlightAssets.delete(assetFingerprint);
        }

        if (result.success) {
          this.completedFingerprints.add(assetFingerprint);
        }

        // Kalan byte eşitleme
        const unread = item.size - fileUploadedBytes;
        if (unread > 0) {
          this.stats.uploadedBytes += unread;
        }

        this.stats.processedFiles++;
        if (this.stats.totalBytes > 0) {
          this.stats.percentage = Math.min(100, Math.round((this.stats.uploadedBytes / this.stats.totalBytes) * 100));
        }

        if (result.success) {
          if (result.status === 'DUPLICATE') {
            this.stats.duplicateCount++;
            this.checkpoint.record(item.fullPath, item.size, 'DUPLICATE', result.id);
            this.log('SKIP', `Zaten mevcut: ${item.name}`);
          } else {
            this.stats.successCount++;
            this.checkpoint.record(item.fullPath, item.size, 'SUCCESS', result.id);
            const liveTag = item.isLivePhoto ? ` (Live Photo 📸+🎥)` : '';
            this.log('SUCCESS', `Yüklendi${liveTag}: ${item.name} (${(item.size / (1024 * 1024)).toFixed(2)} MB)`);
          }
        } else {
          this.stats.errorCount++;
          this.checkpoint.record(item.fullPath, item.size, 'ERROR', '', result.error);
          this.log('ERROR', `Hata: ${item.name} - ${result.error}`);
        }

        this.emit('progress', this.stats);
      }

      this.activeWorkers.delete(workerId);
      this.emit('workers', Array.from(this.activeWorkers.values()));
    };

    for (let i = 0; i < this.concurrency; i++) {
      workerPromises.push(worker(i + 1));
    }

    await Promise.all(workerPromises);

    if (!this.isStopped) {
      this.state = 'COMPLETED';
      if (this.speedSampleTimer) clearInterval(this.speedSampleTimer);
      this.log('SUCCESS', `🎉 Tebrikler! Tüm aktarım tamamlandı: ${this.stats.successCount} yüklendi, ${this.stats.duplicateCount} atlandı, ${this.stats.errorCount} hata.`);
      this.emit('status', { state: this.state, stats: this.stats });
    }
  }
}

module.exports = Migrator;
