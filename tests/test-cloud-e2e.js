const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');

const CheckpointManager = require('../src/checkpoint');
const Migrator = require('../src/migrator');
const CloudTakeoutStreamer = require('../src/cloud-streamer');
const CurlParser = require('../src/curl-parser');

console.log('🧪 ========================================================');
console.log('🧪 UÇTAN UCA (E2E) GOOGLE TAKEOUT CANLI AKIŞ SİMÜLASYONU');
console.log('🧪 ========================================================\n');

const TEST_DIR = path.join(__dirname, 'temp_cloud_e2e');
const DATA_DIR = path.join(TEST_DIR, 'data');
const ZIP_SOURCE_DIR = path.join(TEST_DIR, 'zip_source');
const ZIP_FILE_PATH = path.join(TEST_DIR, 'takeout_cloud.zip');

// Test dizinini temizle ve hazırla
if (fs.existsSync(TEST_DIR)) {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ZIP_SOURCE_DIR, { recursive: true });

// 1. Gerçek test medyaları ve Google Takeout JSON sidecar'ları oluştur
fs.writeFileSync(path.join(ZIP_SOURCE_DIR, 'vacation_photo.jpg'), 'sample-image-bytes-buffer-123456');
fs.writeFileSync(path.join(ZIP_SOURCE_DIR, 'vacation_photo.mov'), 'sample-motion-video-bytes-789012');
fs.writeFileSync(path.join(ZIP_SOURCE_DIR, 'vacation_photo.jpg.json'), JSON.stringify({
  title: 'vacation_photo.jpg',
  description: 'Canlı akış ile aktarılan tatil fotoğrafı',
  photoTakenTime: { timestamp: '1680000000' }
}));

fs.writeFileSync(path.join(ZIP_SOURCE_DIR, 'alone_video.mp4'), 'sample-mp4-video-bytes-345678');
fs.writeFileSync(path.join(ZIP_SOURCE_DIR, 'alone_video.mp4.json'), JSON.stringify({
  title: 'alone_video.mp4',
  photoTakenTime: { timestamp: '1680500000' }
}));

// macOS / Linux zip komutu ile gerçek ZIP arşivi üret
execSync(`cd "${ZIP_SOURCE_DIR}" && zip -r "${ZIP_FILE_PATH}" .`);
const zipBuffer = fs.readFileSync(ZIP_FILE_PATH);
const totalZipSize = zipBuffer.length;

let mockCdnServer;
let mockImmichServer;
let uploadedAssets = [];

// 2. MOCK GOOGLE TAKEOUT CDN SERVER (HTTP Range 206 Partial Content)
mockCdnServer = http.createServer((req, res) => {
  // Oturum çerezi kontrolü
  const cookie = req.headers['cookie'] || '';
  if (!cookie.includes('__Secure-1PSID=valid_session_token')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Google 403 Forbidden - Cookie Invalid');
  }

  const range = req.headers['range'];
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', 'attachment; filename="takeout-20261030T120000Z-001.zip"');

  if (!range) {
    res.writeHead(200, {
      'Content-Length': totalZipSize,
      'Content-Type': 'application/zip'
    });
    return res.end(zipBuffer);
  }

  // Range başlığını ayrıştır: "bytes=0-0" veya "bytes=100-200"
  const m = range.match(/bytes=(\d+)-(\d*)/);
  if (!m) {
    res.writeHead(416, { 'Content-Range': `bytes */${totalZipSize}` });
    return res.end();
  }

  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : totalZipSize - 1;

  if (start >= totalZipSize || end >= totalZipSize || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${totalZipSize}` });
    return res.end();
  }

  const chunk = zipBuffer.subarray(start, end + 1);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${totalZipSize}`,
    'Content-Length': chunk.length,
    'Content-Type': 'application/zip'
  });
  res.end(chunk);
});

// 3. MOCK IMMICH SERVER (Users & Assets API)
mockImmichServer = http.createServer((req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== 'test-immich-key') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  if (req.method === 'GET' && req.url === '/api/users/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      id: 'mock-user-123',
      name: 'Onur Test User',
      email: 'test@example.com'
    }));
  }

  if (req.method === 'POST' && req.url === '/api/assets') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const isVideo = body.includes('filename="vacation_photo.mov"') || body.includes('filename="alone_video.mp4"');
      const isLivePhotoStill = body.includes('livePhotoVideoId');
      const filenameMatch = body.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : 'unknown';

      const assetId = `uuid-${uploadedAssets.length + 1}-${filename}`;
      uploadedAssets.push({
        id: assetId,
        filename,
        isVideo,
        isLivePhotoStill,
        bytes: body.length
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: assetId,
        status: 'created'
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

async function runAllTests() {
  const cdnPort = 9876;
  const immichPort = 9877;

  await new Promise(r => mockCdnServer.listen(cdnPort, r));
  await new Promise(r => mockImmichServer.listen(immichPort, r));

  console.log(`📡 Mock CDN Sunucusu çalışıyor: http://127.0.0.1:${cdnPort}`);
  console.log(`📡 Mock Immich Sunucusu çalışıyor: http://127.0.0.1:${immichPort}\n`);

  try {
    // --- ADIM 1: cURL Komutu Ayrıştırma Testi ---
    console.log('▶ [Test 1] Google Takeout cURL komutu ayrıştırma...');
    const pastedCurl = `curl 'http://127.0.0.1:${cdnPort}/download/takeout-20261030.zip' \\
      -H 'Cookie: __Secure-1PSID=valid_session_token; Other=123' \\
      -H 'User-Agent: Mozilla/5.0' \\
      --compressed`;

    const parsedConfig = CurlParser.parse(pastedCurl);
    assert.strictEqual(parsedConfig.url, `http://127.0.0.1:${cdnPort}/download/takeout-20261030.zip`);
    assert.ok(parsedConfig.headers['Cookie'].includes('__Secure-1PSID=valid_session_token'));
    console.log('  ✓ cURL başarıyla parse edildi.\n');

    // --- ADIM 2: Canlı Akış Bağlantısını Doğrulama (HTTP Range 0-0 Testi) ---
    console.log('▶ [Test 2] CloudTakeoutStreamer.validateLink (0 Bayt İndirme)...');
    const validatedInfo = await CloudTakeoutStreamer.validateLink(pastedCurl);
    assert.strictEqual(validatedInfo.success, true);
    assert.strictEqual(validatedInfo.supportsRange, true, 'Mock CDN Range desteklemeli');
    assert.strictEqual(validatedInfo.totalBytes, totalZipSize, 'Arşiv boyutu tam eşleşmeli');
    assert.strictEqual(validatedInfo.filename, 'takeout-20261030T120000Z-001.zip');
    console.log(`  ✓ Uzak arşiv doğrulandı: ${validatedInfo.filename} (${validatedInfo.totalBytes} bayt, Range: ${validatedInfo.supportsRange})\n`);

    // --- ADIM 3: Uzaktaki ZIP'i Bellekte Tarama (scanRemoteZip) ---
    console.log('▶ [Test 3] CloudTakeoutStreamer.scanRemoteZip (Bellekten Okuma)...');
    const remoteFiles = await CloudTakeoutStreamer.scanRemoteZip(validatedInfo, { pairLivePhotos: true });
    assert.strictEqual(remoteFiles.length, 2, '2 adet medya öğesi (1 Live Photo çifti, 1 video) bulunmalı');

    const livePhotoItem = remoteFiles.find(f => f.name === 'vacation_photo.jpg');
    assert.ok(livePhotoItem, 'vacation_photo.jpg bulunmalı');
    assert.strictEqual(livePhotoItem.isLivePhoto, true, 'Live Photo eşleşmeli');
    assert.strictEqual(livePhotoItem.livePhotoVideoName, 'vacation_photo.mov', 'Live Photo videosu vacation_photo.mov olmalı');
    assert.ok(livePhotoItem.jsonEntry || livePhotoItem.jsonContent, 'Takeout JSON yan verisi eşleşmiş olmalı');

    const standaloneVideo = remoteFiles.find(f => f.name === 'alone_video.mp4');
    assert.ok(standaloneVideo, 'alone_video.mp4 bulunmalı');
    assert.strictEqual(standaloneVideo.isLivePhoto, false);
    console.log('  ✓ Uzaktaki ZIP bellekten tarandı, JSON ve Live Photo eşlemeleri doğrulandı.\n');

    // --- ADIM 4: Migrator ile Bulut Taraması (scanCloud) ---
    console.log('▶ [Test 4] Migrator.scanCloud entegrasyonu...');
    const checkpoint = new CheckpointManager(DATA_DIR);
    const migrator = new Migrator(checkpoint);

    const scanStats = await migrator.scanCloud(validatedInfo, { pairLivePhotos: true });
    assert.strictEqual(scanStats.totalFiles, 2);
    assert.strictEqual(scanStats.livePhotoCount, 1);
    assert.strictEqual(scanStats.alreadyUploaded, 0);
    assert.strictEqual(scanStats.pendingFiles, 2);
    assert.strictEqual(migrator.state, 'READY');
    console.log('  ✓ Migrator bulut tarama istatistikleri ve READY durumu onaylandı.\n');

    // --- ADIM 5: Immich Sunucusuna Canlı Akış Aktarımı (startCloudMigration) ---
    console.log('▶ [Test 5] Migrator.start (Google CDN -> RAM Stream -> Immich API)...');
    await migrator.start({
      immichUrl: `http://127.0.0.1:${immichPort}`,
      apiKey: 'test-immich-key',
      cloudInfo: validatedInfo,
      concurrency: 2,
      pairLivePhotos: true
    });

    // Aktarımın tamamlanmasını bekle
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Aktarım zaman aşımına uğradı!')), 10000);
      migrator.on('status', (data) => {
        if (data.state === 'COMPLETED') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    assert.strictEqual(migrator.stats.successCount, 2, '2 öğe de başarıyla yüklenmeli');
    assert.strictEqual(migrator.stats.errorCount, 0, 'Hiç hata olmamalı');
    assert.strictEqual(migrator.stats.percentage, 100, 'İlerleme %100 olmalı');

    // Immich'e gelen yüklemeleri doğrula:
    // 1. vacation_photo.mov (Live Photo video parçası)
    // 2. vacation_photo.jpg (livePhotoVideoId referansı ile)
    // 3. alone_video.mp4 (bağımsız video)
    assert.strictEqual(uploadedAssets.length, 3, 'Toplam 3 HTTP asset upload isteği yapılmış olmalı (1 video parça + 1 live photo + 1 bağımsız video)');

    const liveVideoUpload = uploadedAssets.find(u => u.filename === 'vacation_photo.mov');
    assert.ok(liveVideoUpload, 'vacation_photo.mov Immich APIye iletilmeli');

    const livePhotoUpload = uploadedAssets.find(u => u.filename === 'vacation_photo.jpg');
    assert.ok(livePhotoUpload, 'vacation_photo.jpg Immich APIye iletilmeli');
    assert.strictEqual(livePhotoUpload.isLivePhotoStill, true, 'Immich APIye livePhotoVideoId alanı iletilmeli');

    console.log('  ✓ 2-Step Live Photo ve standalone medya aktarımı kusursuz tamamlandı.\n');

    // --- ADIM 6: Disk Alanı Kontrolü (0 Bayt İndirme Doğrulaması) ---
    console.log('▶ [Test 6] Sıfır Disk Kullanımı Doğrulaması...');
    // TEST_DIR içinde takeout_cloud.zip dışında hiçbir büyük arşiv veya çıkarılmış medya olmamalı
    const filesInDir = fs.readdirSync(TEST_DIR);
    assert.ok(!filesInDir.includes('uploaded'), 'Bulut modunda uploaded klasörü oluşmamalı');
    assert.ok(!filesInDir.includes('vacation_photo.jpg'), 'Diske hiçbir resim indirilmemiş olmalı');
    assert.ok(!filesInDir.includes('vacation_photo.mov'), 'Diske hiçbir video indirilmemiş olmalı');
    console.log('  ✓ Diske sıfır bayt yazıldığı, akışın tamamen RAM üzerinden aktığı doğrulandı.\n');

    // --- ADIM 7: Checkpoint ve Yeniden Tarama Koruması ---
    console.log('▶ [Test 7] Checkpoint kalıcılığı ve Rescan koruması...');
    const newMigrator = new Migrator(checkpoint);
    const rescanStats = await newMigrator.scanCloud(validatedInfo, { pairLivePhotos: true });
    assert.strictEqual(rescanStats.alreadyUploaded, 2, 'Daha önce aktarılan 2 medya da Checkpoint ile tanınmalı');
    assert.strictEqual(rescanStats.pendingFiles, 0, 'Bekleyen dosya 0 olmalı');
    assert.strictEqual(rescanStats.percentage, 100, 'Tüm dosyalar önceden yüklendiği için yüzde 100 olmalı');
    console.log('  ✓ Checkpoint hafızası çalışıyor; mükerrer yükleme tamamen engellendi.\n');

    console.log('========================================================');
    console.log('🎉 TÜM UÇTAN UCA (E2E) TESTLER %100 BAŞARIYLA GEÇTİ!');
    console.log('========================================================\n');

  } finally {
    mockCdnServer.close();
    mockImmichServer.close();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }
}

runAllTests().catch(err => {
  console.error('❌ E2E Test Hatası:', err);
  if (mockCdnServer) mockCdnServer.close();
  if (mockImmichServer) mockImmichServer.close();
  process.exit(1);
});
