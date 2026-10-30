const path = require('path');
const fs = require('fs');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const CheckpointManager = require('./checkpoint');
const Migrator = require('./migrator');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_TAKEOUT = process.env.TAKEOUT_DIR || '';

const checkpoint = new CheckpointManager(DATA_DIR);
const migrator = new Migrator(checkpoint);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Server-Sent Events (SSE) İstemci Listesi
let sseClients = [];

function sendSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client) => client.res.write(payload));
}

// Migrator olaylarını SSE ile canlı istemcilere yayınla
migrator.on('log', (logEntry) => sendSSE('log', logEntry));
migrator.on('progress', (stats) => sendSSE('progress', stats));
migrator.on('status', (status) => sendSSE('status', status));
migrator.on('workers', (workers) => sendSSE('workers', workers));

// SSE Endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // İlk bağlantıda (sayfa yenilendiğinde) mevcut tüm durumu gönder
  res.write(`event: init\ndata: ${JSON.stringify({
    state: migrator.state,
    stats: migrator.stats,
    logs: migrator.logs.slice(-100),
    activeWorkers: Array.from(migrator.activeWorkers.values()),
    activeConfig: migrator.config ? {
      immichUrl: migrator.config.immichUrl,
      takeoutDir: migrator.config.takeoutDir,
      concurrency: migrator.concurrency
    } : null,
    defaultTakeout: DEFAULT_TAKEOUT,
    envUrl: process.env.IMMICH_INSTANCE_URL || '',
    envKey: process.env.IMMICH_API_KEY ? '••••••••' : ''
  })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

// API: Bağlantı Testi & Kullanıcı Bilgisi
app.post('/api/test-connection', async (req, res) => {
  try {
    const { immichUrl, apiKey } = req.body;
    if (!immichUrl || !apiKey) {
      return res.status(400).json({ error: 'Immich URL ve API Key gereklidir.' });
    }
    const user = await migrator.testConnection(immichUrl, apiKey);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// API: Klasör Tarama
app.post('/api/scan', async (req, res) => {
  try {
    const { takeoutDir, scanExtracted, scanZips, pairLivePhotos } = req.body;
    const targetDir = takeoutDir || DEFAULT_TAKEOUT;

    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: `Klasör bulunamadı: ${targetDir}` });
    }

    const stats = await migrator.scan(targetDir, {
      scanExtracted: scanExtracted !== false,
      scanZips: scanZips !== false,
      pairLivePhotos: pairLivePhotos !== false
    });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Dizin Gezgini (Klasör Gözat / Browse)
app.get('/api/browse', (req, res) => {
  try {
    let queryPath = req.query.path;
    let targetDir;

    if (queryPath && queryPath.trim()) {
      targetDir = path.resolve(queryPath);
    } else if (process.env.TAKEOUT_DIR && fs.existsSync(process.env.TAKEOUT_DIR)) {
      targetDir = process.env.TAKEOUT_DIR;
    } else if (fs.existsSync('/takeout')) {
      targetDir = '/takeout';
    } else {
      targetDir = '/';
    }

    if (!fs.existsSync(targetDir)) {
      targetDir = process.cwd();
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      targetDir = path.dirname(targetDir);
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const directories = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        directories.push({
          name: entry.name,
          path: path.join(targetDir, entry.name)
        });
      }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(targetDir);
    res.json({
      success: true,
      current: targetDir,
      parent: parent !== targetDir ? parent : null,
      directories
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Aktarımı Başlat
app.post('/api/start', async (req, res) => {
  try {
    const {
      immichUrl,
      apiKey,
      takeoutDir,
      concurrency,
      scanExtracted,
      scanZips,
      pairLivePhotos,
      organizeMedia,
      organizeAction,
      organizeOutputDir
    } = req.body;

    if (!immichUrl || !apiKey) {
      return res.status(400).json({ error: 'Immich URL ve API Key eksik!' });
    }

    await migrator.start({
      immichUrl,
      apiKey,
      takeoutDir: takeoutDir || DEFAULT_TAKEOUT,
      concurrency: concurrency || 4,
      scanExtracted: scanExtracted !== false,
      scanZips: scanZips !== false,
      pairLivePhotos: pairLivePhotos !== false,
      organizeMedia: organizeMedia !== false,
      organizeAction: organizeAction || 'move',
      organizeOutputDir: organizeOutputDir || null
    });

    res.json({ success: true, state: migrator.state });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Duraklat
app.post('/api/pause', (req, res) => {
  migrator.pause();
  res.json({ success: true, state: migrator.state });
});

// API: Devam Et
app.post('/api/resume', (req, res) => {
  migrator.resume();
  res.json({ success: true, state: migrator.state });
});

// API: Durdur
app.post('/api/stop', (req, res) => {
  migrator.stop();
  res.json({ success: true, state: migrator.state });
});

// API: Güncel Durum
app.get('/api/status', (req, res) => {
  res.json({
    state: migrator.state,
    stats: migrator.stats,
    activeWorkers: Array.from(migrator.activeWorkers.values()),
    defaultTakeout: DEFAULT_TAKEOUT
  });
});

// API: Log Dosyasını İndir
app.get('/api/logs/download', (req, res) => {
  const logFile = path.join(DATA_DIR, 'transfer.log');
  if (fs.existsSync(logFile)) {
    res.download(logFile, 'immich-transfer.log');
  } else {
    res.status(404).send('Henüz log dosyası oluşmadı.');
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Immich Transfer Web Sunucusu Başlatıldı!`);
  console.log(`🌐 Web Arayüzü: http://localhost:${PORT}`);
  console.log(`📁 Veri Dizini (Log/Checkpoint): ${DATA_DIR}`);
  console.log(`📂 Varsayılan Takeout Dizini: ${DEFAULT_TAKEOUT}`);
  console.log(`=======================================================`);
});
