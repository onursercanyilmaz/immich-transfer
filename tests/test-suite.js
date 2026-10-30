const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CheckpointManager = require('../src/checkpoint');
const TakeoutScanner = require('../src/takeout');
const ImmichClient = require('../src/immich');
const Migrator = require('../src/migrator');

const TEST_DIR = path.join(__dirname, 'temp_test_data');
const TEST_CHECKPOINT_DIR = path.join(TEST_DIR, 'checkpoint');
const TEST_TAKEOUT_DIR = path.join(TEST_DIR, 'takeout');

describe('Immich Google Takeout Migrator Test Suite', () => {
  let mockServer;
  let mockServerPort = 9876;
  let uploadedAssets = new Map();

  before(() => {
    // Setup test directories
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_CHECKPOINT_DIR, { recursive: true });
    fs.mkdirSync(TEST_TAKEOUT_DIR, { recursive: true });

    // 1. Standart dosya ve JSON
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'standard.jpg'), 'fake-image-bytes-1');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'standard.jpg.json'), JSON.stringify({
      title: 'standard.jpg',
      description: 'Yılbaşı Tatili 2023',
      photoTakenTime: { timestamp: '1672531199' }, // 2022-12-31T23:59:59.000Z
      favorited: true
    }));

    // 2. Uzantısız JSON (no_ext.png -> no_ext.json)
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'no_ext.png'), 'fake-png-bytes-2');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'no_ext.json'), JSON.stringify({
      title: 'no_ext.png',
      photoTakenTime: { timestamp: '1609459200' }, // 2021-01-01T00:00:00.000Z
      favorited: false
    }));

    // 3. Google Takeout Parantezli Kopya (copy(1).jpg -> copy.jpg(1).json)
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'copy(1).jpg'), 'fake-image-bytes-3');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'copy.jpg(1).json'), JSON.stringify({
      title: 'copy.jpg',
      photoTakenTime: { timestamp: '1622505600' } // 2021-06-01T00:00:00.000Z
    }));

    // 4. Kırpılmış (Truncated) Uzun Dosya Adı (>45 karakter)
    const longName = 'this_is_a_very_long_file_name_that_google_photos_exports_truncated.jpg';
    const truncatedJson = 'this_is_a_very_long_file_name_that_google_photos_ex.json';
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, longName), 'fake-long-bytes-4');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, truncatedJson), JSON.stringify({
      photoTakenTime: { timestamp: '1640995200' },
      description: 'Uzun dosya açıklaması'
    }));

    // 5. Desteklenmeyen dosya (Taramada elenmeli)
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'document.pdf'), 'fake-pdf');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'notes.txt'), 'notes');

    // Mock Immich HTTP Server Kurulumu
    mockServer = http.createServer((req, res) => {
      // Auth kontrolü
      const apiKey = req.headers['x-api-key'];
      if (!apiKey || apiKey !== 'test-valid-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Unauthorized' }));
      }

      if (req.method === 'GET' && req.url === '/api/users/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'user-guid-999',
          name: 'Demo User',
          email: 'demo@example.com',
          isAdmin: true
        }));
      }

      if (req.method === 'POST' && req.url === '/api/assets') {
        let bodyChunks = [];
        req.on('data', chunk => bodyChunks.push(chunk));
        req.on('end', () => {
          const bodyBuffer = Buffer.concat(bodyChunks);
          const bodyStr = bodyBuffer.toString('latin1');

          // deviceAssetId ayıkla
          const match = bodyStr.match(/name="deviceAssetId"\r\n\r\n([a-f0-9]+)/);
          const deviceAssetId = match ? match[1] : 'unknown';

          // Duplicate kontrolü
          if (uploadedAssets.has(deviceAssetId)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'duplicate', id: uploadedAssets.get(deviceAssetId) }));
          }

          const assetId = 'asset-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
          uploadedAssets.set(deviceAssetId, assetId);

          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ id: assetId, status: 'created' }));
        });
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    mockServer.listen(mockServerPort);
  });

  after(() => {
    if (mockServer) mockServer.close();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // TEST 1: Google Takeout Tarama ve JSON Eşleştirme
  test('1. TakeoutScanner: Dosya tarama ve JSON meta veri eşleştirme', () => {
    const files = TakeoutScanner.scanDirectory(TEST_TAKEOUT_DIR);

    // Desteklenmeyen pdf ve txt elenmiş olmalı, 4 medya dosyası bulunmalı
    assert.equal(files.length, 4, 'Sadece desteklenen 4 medya dosyası bulunmalı');

    // Standart JSON eşleme kontrolü
    const stdFile = files.find(f => f.name === 'standard.jpg');
    assert.ok(stdFile, 'standard.jpg bulunmalı');
    const stdMeta = TakeoutScanner.parseMetadata(stdFile.fullPath, stdFile.mtime);
    assert.equal(stdMeta.createdAt, '2022-12-31T23:59:59.000Z', 'Yılbaşı timestampi doğru parse edilmeli');
    assert.equal(stdMeta.isFavorite, true, 'Favori true olmalı');
    assert.equal(stdMeta.description, 'Yılbaşı Tatili 2023', 'Açıklama okunmalı');

    // Uzantısız JSON kontrolü (no_ext.png -> no_ext.json)
    const noExtFile = files.find(f => f.name === 'no_ext.png');
    assert.ok(noExtFile, 'no_ext.png bulunmalı');
    const noExtMeta = TakeoutScanner.parseMetadata(noExtFile.fullPath, noExtFile.mtime);
    assert.equal(noExtMeta.createdAt, '2021-01-01T00:00:00.000Z');

    // Parantezli kopya eşleme kontrolü (copy(1).jpg -> copy.jpg(1).json)
    const copyFile = files.find(f => f.name === 'copy(1).jpg');
    assert.ok(copyFile, 'copy(1).jpg bulunmalı');
    const copyMeta = TakeoutScanner.parseMetadata(copyFile.fullPath, copyFile.mtime);
    assert.equal(copyMeta.createdAt, '2021-06-01T00:00:00.000Z', 'Parantezli JSON doğru eşleşmeli');

    // Truncated (kırpılmış) isim eşleme kontrolü
    const longFile = files.find(f => f.name.startsWith('this_is_a_very_long'));
    assert.ok(longFile, 'Uzun isimli dosya bulunmalı');
    const longMeta = TakeoutScanner.parseMetadata(longFile.fullPath, longFile.mtime);
    assert.equal(longMeta.description, 'Uzun dosya açıklaması', 'Kırpılmış JSON meta verisi okunmalı');
  });

  // TEST 2: CheckpointManager (fsync ve Yeniden Başlatma Dayanıklılığı)
  test('2. CheckpointManager: fsync disk kaydı ve kesinti sonrası hafıza', () => {
    const cp = new CheckpointManager(TEST_CHECKPOINT_DIR);

    assert.equal(cp.isUploaded('/test/path/photo1.jpg'), false, 'Başlangıçta yüklenmemiş olmalı');

    // Başarılı yükleme kaydet
    cp.record('/test/path/photo1.jpg', 1024, 'SUCCESS', 'immich-id-1');
    assert.equal(cp.isUploaded('/test/path/photo1.jpg'), true, 'Kayıttan sonra uploaded olmalı');

    // Duplicate kaydet
    cp.record('/test/path/photo2.jpg', 2048, 'DUPLICATE', 'immich-id-2');
    assert.equal(cp.isUploaded('/test/path/photo2.jpg'), true, 'Duplicate de atlanacaklar listesinde olmalı');

    // Hata kaydet
    cp.record('/test/path/photo3.jpg', 512, 'ERROR', '', 'Network Timeout');
    assert.equal(cp.isUploaded('/test/path/photo3.jpg'), false, 'Hatalı olan dosya uploaded sayılmamalı (tekrar denenmeli)');

    // Simülasyon: Bilgisayar kapandı veya container yeniden başladı
    const cpRestarted = new CheckpointManager(TEST_CHECKPOINT_DIR);
    assert.equal(cpRestarted.isUploaded('/test/path/photo1.jpg'), true, 'Yeniden başlatma sonrası diskten başarıyla okunmalı');
    assert.equal(cpRestarted.isUploaded('/test/path/photo2.jpg'), true, 'Duplicate diskten okunmalı');
    assert.equal(cpRestarted.isUploaded('/test/path/photo3.jpg'), false, 'Hatalı olan tekrar yüklenebilir durumda kalmalı');
  });

  // TEST 3: ImmichClient API ve Multipart Upload Testi
  test('3. ImmichClient: /api/users/me doğrulama ve /api/assets yükleme', async () => {
    const validClient = new ImmichClient(`http://localhost:${mockServerPort}`, 'test-valid-key');
    const user = await validClient.getCurrentUser();
    assert.equal(user.name, 'Demo User', 'Kullanıcı adı doğru dönmeli');
    assert.equal(user.email, 'demo@example.com', 'E-posta doğru dönmeli');

    // Geçersiz API Key testi
    const invalidClient = new ImmichClient(`http://localhost:${mockServerPort}`, 'wrong-key');
    await assert.rejects(
      async () => await invalidClient.getCurrentUser(),
      /API Anahtarı geçersiz/,
      'Hatalı API anahtarında hata fırlatmalı'
    );

    // Dosya yükleme testi
    const testFile = path.join(TEST_TAKEOUT_DIR, 'standard.jpg');
    const meta = TakeoutScanner.parseMetadata(testFile);
    let chunkCount = 0;
    const res = await validClient.uploadAsset(testFile, meta, (len) => {
      chunkCount += len;
    });

    assert.equal(res.success, true, 'Yükleme başarılı olmalı');
    assert.equal(res.status, 'SUCCESS');
    assert.ok(chunkCount > 0, 'Chunk ilerleme callback çağrılmalı');

    // Aynı dosyayı tekrar yükleme testi (Duplicate - 409)
    const duplicateRes = await validClient.uploadAsset(testFile, meta);
    assert.equal(duplicateRes.success, true);
    assert.equal(duplicateRes.status, 'DUPLICATE', 'İkinci yüklemede duplicate tespit edilmeli');
  });

  // TEST 4: End-to-End Migrator Süreci (Tarama -> Paralel Aktarım -> Tamamlanma)
  test('4. End-to-End Migrator: Tam otomatik göç senaryosu', async () => {
    const cp = new CheckpointManager(path.join(TEST_DIR, 'migrator_checkpoint'));
    const migrator = new Migrator(cp);

    // 1. Tarama
    const scanStats = await migrator.scan(TEST_TAKEOUT_DIR);
    assert.equal(scanStats.totalFiles, 4, '4 medya taranmalı');
    assert.equal(scanStats.pendingFiles, 4, '4 dosya bekliyor olmalı');

    // 2. Aktarımı Başlat
    const completedPromise = new Promise((resolve) => {
      migrator.on('status', (evt) => {
        if (evt.state === 'COMPLETED') resolve(evt.stats);
      });
    });

    migrator.start({
      immichUrl: `http://localhost:${mockServerPort}`,
      apiKey: 'test-valid-key',
      concurrency: 2
    });

    const finalStats = await completedPromise;

    assert.equal(finalStats.processedFiles, 4, 'Tüm 4 dosya işlenmiş olmalı');
    assert.equal(finalStats.errorCount, 0, 'Sıfır hata olmalı');
    assert.equal(finalStats.percentage, 100, 'İlerleme %100 olmalı');
    assert.ok(finalStats.successCount > 0, 'Başarılı yüklemeler olmalı');

    // 3. İkinci tarama (Tüm dosyalar checkpoint'te olduğu için 0 bekleyen olmalı)
    const secondScan = await migrator.scan(TEST_TAKEOUT_DIR);
    assert.equal(secondScan.alreadyUploaded, 4, '4 dosya da artık checkpointte bulunmalı');
    assert.equal(secondScan.pendingFiles, 0, 'Yüklenecek yeni dosya kalmamış olmalı');
  });

  // TEST 5: Dizin Gezgini (Folder Browser) Testi
  test('5. Folder Browser: Dizin listeleme ve gezinti', () => {
    const subFolder = path.join(TEST_TAKEOUT_DIR, 'SubAlbum2023');
    fs.mkdirSync(subFolder, { recursive: true });

    const entries = fs.readdirSync(TEST_TAKEOUT_DIR, { withFileTypes: true });
    const directories = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);

    assert.ok(directories.includes('SubAlbum2023'), 'Alt albüm klasörü listede bulunmalı');
  });

  // TEST 6: Paralel Aynı Dosya Yüklenmesini Engelleme (In-Flight Mutex)
  test('6. In-Flight Deduplication: Farklı klasörlerdeki aynı dosyanın tespiti ve ağ harcamadan atlanması', async () => {
    // Takeout klasöründe iki farklı yere birebir aynı dosyayı koyalım
    const folderA = path.join(TEST_TAKEOUT_DIR, 'Photos_2023');
    const folderB = path.join(TEST_TAKEOUT_DIR, 'Album_Holiday');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const fileA = path.join(folderA, 'duplicate_test.jpg');
    const fileB = path.join(folderB, 'duplicate_test.jpg');
    const sameContent = 'identical-photo-binary-content-12345';
    fs.writeFileSync(fileA, sameContent);
    fs.writeFileSync(fileB, sameContent);

    // Aynı JSON meta verisini koyalım
    const jsonContent = JSON.stringify({ photoTakenTime: { timestamp: '1672531199' } });
    fs.writeFileSync(fileA + '.json', jsonContent);
    fs.writeFileSync(fileB + '.json', jsonContent);

    const cp = new CheckpointManager(path.join(TEST_DIR, 'dedup_checkpoint'));
    const migrator = new Migrator(cp);

    // Sadece bu iki dosyayı aktaralım
    migrator.filesToProcess = [
      { fullPath: fileA, name: 'duplicate_test.jpg', size: sameContent.length, mtime: new Date() },
      { fullPath: fileB, name: 'duplicate_test.jpg', size: sameContent.length, mtime: new Date() }
    ];
    migrator.stats.totalBytes = sameContent.length * 2;
    migrator.stats.pendingFiles = 2;

    const completedPromise = new Promise((resolve) => {
      migrator.on('status', (evt) => {
        if (evt.state === 'COMPLETED') resolve(evt.stats);
      });
    });

    migrator.start({
      immichUrl: `http://localhost:${mockServerPort}`,
      apiKey: 'test-valid-key',
      concurrency: 2 // Paralel olarak ikisi birden havuza girer
    });

    const stats = await completedPromise;
    assert.equal(stats.successCount, 1, 'Dosyalardan sadece biri sunucuya yüklenmeli');
    assert.equal(stats.duplicateCount, 1, 'Diğer kopya duplicate olarak yerelde yakalanmalı');
    assert.equal(stats.errorCount, 0, 'Hata oluşmamalı');
  });
});
