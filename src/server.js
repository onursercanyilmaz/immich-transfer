const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const CheckpointManager = require('./checkpoint');
const Migrator = require('./migrator');
const GoogleDriveService = require('./google-drive');
const CloudTakeoutStreamer = require('./cloud-streamer');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_TAKEOUT = process.env.TAKEOUT_DIR || '';

const checkpoint = new CheckpointManager(DATA_DIR);
const migrator = new Migrator(checkpoint);
const googleDriveService = new GoogleDriveService();
let connectedGoogleUser = null;

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
      // macOS/Linux kullanıcısının ana klasörü (örn: /Users/onur)
      targetDir = os.homedir() || process.cwd();
    }

    if (!fs.existsSync(targetDir)) {
      targetDir = os.homedir() || process.cwd();
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      targetDir = path.dirname(targetDir);
    }

    let entries = [];
    try {
      entries = fs.readdirSync(targetDir, { withFileTypes: true });
    } catch (readErr) {
      return res.json({
        success: true,
        current: targetDir,
        parent: path.dirname(targetDir) !== targetDir ? path.dirname(targetDir) : null,
        directories: [],
        warning: `Erişim kısıtlı: ${readErr.message}`
      });
    }

    const directories = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        directories.push({
          name: entry.name,
          path: path.join(targetDir, entry.name),
          isZip: false
        });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        directories.push({
          name: entry.name,
          path: path.join(targetDir, entry.name),
          isZip: true
        });
      }
    }

    directories.sort((a, b) => {
      if (a.isZip !== b.isZip) return a.isZip ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

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

// =======================================================
// GOOGLE TAKEOUT CANLI AKIŞ (CLOUD STREAM PIPE) ROUTES
// =======================================================

// Canlı Akış Bağlantısını Doğrula (0 Bayt İndirme)
app.post('/api/cloud-stream/validate', async (req, res) => {
  try {
    const { curlOrUrl } = req.body;
    if (!curlOrUrl || !curlOrUrl.trim()) {
      return res.status(400).json({ success: false, error: 'Lütfen cURL komutu veya indirme bağlantısı girin.' });
    }

    const validatedInfo = await CloudTakeoutStreamer.validateLink(curlOrUrl);
    res.json({ success: true, info: validatedInfo });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Canlı Akış Arşivini Tara (Bellekte İndirmeden)
app.post('/api/cloud-stream/scan', async (req, res) => {
  try {
    const { validatedInfo, pairLivePhotos } = req.body;
    if (!validatedInfo || !validatedInfo.finalUrl) {
      return res.status(400).json({ success: false, error: 'Doğrulanmış arşiv bilgisi eksik.' });
    }

    const stats = await migrator.scanCloud(validatedInfo, {
      pairLivePhotos: pairLivePhotos !== false
    });
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Canlı Akış Aktarımını Başlat (0 Bayt Yerel Disk, 0 Bayt Drive Kotası)
app.post('/api/cloud-stream/start', async (req, res) => {
  try {
    const {
      immichUrl,
      apiKey,
      validatedInfo,
      concurrency,
      pairLivePhotos
    } = req.body;

    if (!immichUrl || !apiKey) {
      return res.status(400).json({ success: false, error: 'Immich URL ve API Key eksik!' });
    }

    if (!validatedInfo || !validatedInfo.finalUrl) {
      return res.status(400).json({ success: false, error: 'Doğrulanmış Takeout bağlantısı eksik!' });
    }

    await migrator.start({
      immichUrl,
      apiKey,
      cloudInfo: validatedInfo,
      concurrency: concurrency || 4,
      pairLivePhotos: pairLivePhotos !== false,
      organizeMedia: false // Bulut akışında yerel dosya olmadığı için organize kapatılır
    });

    res.json({ success: true, state: migrator.state });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =======================================================
// GOOGLE CONNECT & DIRECT CLOUD MIGRATION ROUTES
// =======================================================

// Google Bağlantı Durumu
app.get('/api/google/status', (req, res) => {
  res.json({
    hasCredentials: !!(googleDriveService.clientId && googleDriveService.clientSecret),
    isConnected: !!connectedGoogleUser,
    user: connectedGoogleUser
  });
});

// Google Cloud API Kimlik Bilgilerini Yapılandır
app.post('/api/google/config', (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ success: false, error: 'Client ID ve Client Secret zorunludur.' });
  }

  googleDriveService.clientId = clientId.trim();
  googleDriveService.clientSecret = clientSecret.trim();
  if (redirectUri) googleDriveService.redirectUri = redirectUri.trim();

  googleDriveService.oauth2Client = new (require('googleapis').google.auth.OAuth2)(
    googleDriveService.clientId,
    googleDriveService.clientSecret,
    googleDriveService.redirectUri
  );

  res.json({ success: true, message: 'Google Cloud kimlik bilgileri güncellendi.' });
});

// Google OAuth Giriş Bağlantısını Üret
app.get('/auth/google/url', (req, res) => {
  try {
    const authUrl = googleDriveService.getAuthUrl();
    res.json({ success: true, url: authUrl });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Google OAuth Geri Dönüş (Callback)
app.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Yetkilendirme kodu bulunamadı.');
    }

    const { tokens, user } = await googleDriveService.exchangeCode(code);
    connectedGoogleUser = user;

    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Google Bağlantısı Başarılı</title>
          <style>
            body { background: #090a0f; color: #fff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #12151f; padding: 2rem; border-radius: 1rem; border: 1px solid #27272a; text-align: center; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>🎉 Google Hesabı Başarıyla Bağlandı!</h2>
            <p>${user.name || user.email}</p>
            <p>Pencere kapatılıyor, panele yönlendiriliyorsunuz...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_CONNECTED', user: ${JSON.stringify(user)} }, '*');
                window.close();
              } else {
                window.location.href = '/?google_connected=1';
              }
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Google yetkilendirme hatası: ${err.message}`);
  }
});

// Google Drive'daki Takeout Arşivlerini Listele
app.get('/api/google/archives', async (req, res) => {
  try {
    if (!connectedGoogleUser) {
      return res.status(401).json({ success: false, error: 'Google hesabı bağlı değil.' });
    }

    const archives = await googleDriveService.listTakeoutArchives();
    res.json({ success: true, archives });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Google Hesabının Bağlantısını Kes
app.post('/api/google/disconnect', (req, res) => {
  connectedGoogleUser = null;
  googleDriveService.tokens = null;
  googleDriveService.drive = null;
  res.json({ success: true, message: 'Google bağlantısı kesildi.' });
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
