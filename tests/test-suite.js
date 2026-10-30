const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const CheckpointManager = require('../src/checkpoint');
const TakeoutScanner = require('../src/takeout');
const ImmichClient = require('../src/immich');
const Migrator = require('../src/migrator');
const MediaOrganizer = require('../src/organizer');

const TEST_DIR = path.join(__dirname, 'temp_test_data');
const TEST_CHECKPOINT_DIR = path.join(TEST_DIR, 'checkpoint');
const TEST_TAKEOUT_DIR = path.join(TEST_DIR, 'takeout');

describe('Immich Transfer Test Suite (ZIP & Live Photo Edition)', () => {
  let mockServer;
  let mockServerPort = 9876;
  let uploadedAssets = new Map();
  let livePhotoUploadedCount = 0;

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

    // 6. Live Photo / Motion Photo Çifti (apple_live.heic + apple_live.mov)
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'apple_live.heic'), 'fake-heic-still-photo');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'apple_live.mov'), 'fake-mov-motion-video');
    fs.writeFileSync(path.join(TEST_TAKEOUT_DIR, 'apple_live.heic.json'), JSON.stringify({
      photoTakenTime: { timestamp: '1654041600' }
    }));

    // 7. Doğrudan ZIP Dosyası Oluşturma (takeout_archive.zip)
    const zipDir = path.join(TEST_DIR, 'zip_source');
    fs.mkdirSync(zipDir, { recursive: true });
    fs.writeFileSync(path.join(zipDir, 'photo_inside_zip.jpg'), 'fake-zipped-image-content');
    fs.writeFileSync(path.join(zipDir, 'photo_inside_zip.jpg.json'), JSON.stringify({
      photoTakenTime: { timestamp: '1664582400' },
      description: 'ZIP içinden okunan fotoğraf'
    }));
    // zip_live.jpg + zip_live.mp4 (ZIP içinde Live Photo çifti)
    fs.writeFileSync(path.join(zipDir, 'zip_live.jpg'), 'fake-zipped-still');
    fs.writeFileSync(path.join(zipDir, 'zip_live.mp4'), 'fake-zipped-motion');

    const zipDest = path.join(TEST_DIR, 'test_takeout.zip');
    execSync(`cd "${zipDir}" && zip -r "${zipDest}" .`);

    // Mock Immich HTTP Server Kurulumu
    mockServer = http.createServer((req, res) => {
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

          // Live Photo kontrolü (Immich resmi spesifikasyonu: livePhotoVideoId)
          if (bodyStr.includes('name="livePhotoVideoId"') || bodyStr.includes('name="livePhotoData"')) {
            livePhotoUploadedCount++;
          }

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

  // TEST 1: Dosya Tarama ve JSON Meta Veri Eşleştirme
  test('1. TakeoutScanner: Dosya tarama ve JSON meta veri eşleştirme', async () => {
    const files = await TakeoutScanner.scan(TEST_TAKEOUT_DIR);

    // standard.jpg, no_ext.png, copy(1).jpg, longName.jpg, apple_live.heic (apple_live.mov Live Photo olarak bağlandı!)
    const standardFile = files.find(f => f.name === 'standard.jpg');
    assert.ok(standardFile, 'standard.jpg bulunmalı');
    const stdMeta = await TakeoutScanner.parseMetadata(standardFile);
    assert.equal(stdMeta.createdAt, '2022-12-31T23:59:59.000Z', 'Yılbaşı timestampi doğru parse edilmeli');
    assert.equal(stdMeta.isFavorite, true, 'Favori true olmalı');
    assert.equal(stdMeta.description, 'Yılbaşı Tatili 2023', 'Açıklama okunmalı');

    // Uzantısız JSON kontrolü (no_ext.png -> no_ext.json)
    const noExtFile = files.find(f => f.name === 'no_ext.png');
    assert.ok(noExtFile, 'no_ext.png bulunmalı');
    const noExtMeta = await TakeoutScanner.parseMetadata(noExtFile);
    assert.equal(noExtMeta.createdAt, '2021-01-01T00:00:00.000Z');

    // Parantezli kopya eşleme kontrolü (copy(1).jpg -> copy.jpg(1).json)
    const copyFile = files.find(f => f.name === 'copy(1).jpg');
    assert.ok(copyFile, 'copy(1).jpg bulunmalı');
    const copyMeta = await TakeoutScanner.parseMetadata(copyFile);
    assert.equal(copyMeta.createdAt, '2021-06-01T00:00:00.000Z');

    // Truncated (kırpılmış) isim eşleme kontrolü
    const longFile = files.find(f => f.name.startsWith('this_is_a_very_long'));
    assert.ok(longFile, 'Uzun isimli dosya bulunmalı');
    const longMeta = await TakeoutScanner.parseMetadata(longFile);
    assert.equal(longMeta.description, 'Uzun dosya açıklaması');
  });

  // TEST 2: CheckpointManager (fsync ve Yeniden Başlatma Dayanıklılığı)
  test('2. CheckpointManager: fsync disk kaydı ve kesinti sonrası hafıza', () => {
    const cp = new CheckpointManager(TEST_CHECKPOINT_DIR);

    assert.equal(cp.isUploaded('/test/path/photo1.jpg'), false);
    cp.record('/test/path/photo1.jpg', 1024, 'SUCCESS', 'immich-id-1');
    assert.equal(cp.isUploaded('/test/path/photo1.jpg'), true);

    cp.record('/test/path/photo2.jpg', 2048, 'DUPLICATE', 'immich-id-2');
    assert.equal(cp.isUploaded('/test/path/photo2.jpg'), true);

    cp.record('/test/path/photo3.jpg', 512, 'ERROR', '', 'Network Timeout');
    assert.equal(cp.isUploaded('/test/path/photo3.jpg'), false);

    // Yeniden başlatma simülasyonu
    const cpRestarted = new CheckpointManager(TEST_CHECKPOINT_DIR);
    assert.equal(cpRestarted.isUploaded('/test/path/photo1.jpg'), true);
    assert.equal(cpRestarted.isUploaded('/test/path/photo2.jpg'), true);
    assert.equal(cpRestarted.isUploaded('/test/path/photo3.jpg'), false);
  });

  // TEST 3: ImmichClient API ve Multipart Upload Testi
  test('3. ImmichClient: /api/users/me doğrulama ve /api/assets yükleme', async () => {
    const validClient = new ImmichClient(`http://localhost:${mockServerPort}`, 'test-valid-key');
    const user = await validClient.getCurrentUser();
    assert.equal(user.name, 'Demo User');
    assert.equal(user.email, 'demo@example.com');

    const invalidClient = new ImmichClient(`http://localhost:${mockServerPort}`, 'wrong-key');
    await assert.rejects(
      async () => await invalidClient.getCurrentUser(),
      /API Anahtarı geçersiz/
    );

    const testFile = path.join(TEST_TAKEOUT_DIR, 'standard.jpg');
    const meta = await TakeoutScanner.parseMetadata({ fullPath: testFile });
    let chunkCount = 0;
    const res = await validClient.uploadAsset(testFile, meta, (len) => {
      chunkCount += len;
    });

    assert.equal(res.success, true);
    assert.equal(res.status, 'SUCCESS');
    assert.ok(chunkCount > 0);

    const duplicateRes = await validClient.uploadAsset(testFile, meta);
    assert.equal(duplicateRes.success, true);
    assert.equal(duplicateRes.status, 'DUPLICATE');
  });

  // TEST 4: End-to-End Migrator Süreci (Tarama -> Paralel Aktarım -> Tamamlanma)
  test('4. End-to-End Migrator: Tam otomatik göç senaryosu', async () => {
    const cp = new CheckpointManager(path.join(TEST_DIR, 'migrator_checkpoint'));
    const migrator = new Migrator(cp);

    const scanStats = await migrator.scan(TEST_TAKEOUT_DIR);
    assert.ok(scanStats.totalFiles >= 5, 'En az 5 medya dosyası taranmalı');

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
    assert.equal(finalStats.errorCount, 0, 'Sıfır hata olmalı');
    assert.equal(finalStats.percentage, 100, 'İlerleme %100 olmalı');
    assert.ok(finalStats.successCount > 0);
  });

  // TEST 5: Dizin Gezgini (Folder Browser) Testi
  test('5. Folder Browser: Dizin listeleme ve gezinti', () => {
    const subFolder = path.join(TEST_TAKEOUT_DIR, 'SubAlbum2023');
    fs.mkdirSync(subFolder, { recursive: true });

    const entries = fs.readdirSync(TEST_TAKEOUT_DIR, { withFileTypes: true });
    const directories = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);

    assert.ok(directories.includes('SubAlbum2023'));
  });

  // TEST 6: Paralel Aynı Dosya Yüklenmesini Engelleme (In-Flight Mutex)
  test('6. In-Flight Deduplication: Farklı klasörlerdeki aynı dosyanın tespiti ve ağ harcamadan atlanması', async () => {
    const folderA = path.join(TEST_TAKEOUT_DIR, 'Photos_2023');
    const folderB = path.join(TEST_TAKEOUT_DIR, 'Album_Holiday');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const fileA = path.join(folderA, 'duplicate_test.jpg');
    const fileB = path.join(folderB, 'duplicate_test.jpg');
    const sameContent = 'identical-photo-binary-content-12345';
    fs.writeFileSync(fileA, sameContent);
    fs.writeFileSync(fileB, sameContent);

    const jsonContent = JSON.stringify({ photoTakenTime: { timestamp: '1672531199' } });
    fs.writeFileSync(fileA + '.json', jsonContent);
    fs.writeFileSync(fileB + '.json', jsonContent);

    const cp = new CheckpointManager(path.join(TEST_DIR, 'dedup_checkpoint'));
    const migrator = new Migrator(cp);

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
      concurrency: 2
    });

    const stats = await completedPromise;
    assert.equal(stats.successCount, 1, 'Dosyalardan sadece biri sunucuya yüklenmeli');
    assert.equal(stats.duplicateCount, 1, 'Diğer kopya duplicate olarak yerelde yakalanmalı');
  });

  // TEST 7: Live Photo / Motion Photo Otomatik Eşleştirme ve Yükleme Testi
  test('7. Live Photo Pairing: HEIC/JPG ve MOV/MP4 çiftinin tespit edilip livePhotoData ile aktarılması', async () => {
    const files = await TakeoutScanner.scan(TEST_TAKEOUT_DIR);
    const livePhotoItem = files.find(f => f.name === 'apple_live.heic');

    assert.ok(livePhotoItem, 'apple_live.heic taranmış olmalı');
    assert.equal(livePhotoItem.isLivePhoto, true, 'isLivePhoto true olarak tespit edilmeli');
    assert.equal(livePhotoItem.livePhotoVideoName, 'apple_live.mov', 'Eşleşen video apple_live.mov olmalı');

    // Standalone video olarak apple_live.mov listeye girmemeli (Live Photo ile birleşti)
    const standaloneMov = files.find(f => f.name === 'apple_live.mov');
    assert.equal(standaloneMov, undefined, 'Eşleşen video tekil olarak listeye tekrar girmemeli');

    // Immich'e livePhotoData ile upload testi
    const client = new ImmichClient(`http://localhost:${mockServerPort}`, 'test-valid-key');
    const initialLivePhotoCount = livePhotoUploadedCount;
    const meta = await TakeoutScanner.parseMetadata(livePhotoItem);
    const res = await client.uploadAsset(livePhotoItem, meta);

    assert.equal(res.success, true);
    assert.equal(livePhotoUploadedCount, initialLivePhotoCount + 1, 'Immich mock sunucusuna livePhotoData multipart alanı iletilmeli');
  });

  // TEST 8: Doğrudan ZIP Dosyası Okuma (Zero-Extraction Stream Testi)
  test('8. Streaming ZIP Archive: .zip dosyasını dışarı çıkarmadan içerisinden doğrudan okuma ve Live Photo', async () => {
    const zipPath = path.join(TEST_DIR, 'test_takeout.zip');
    assert.ok(fs.existsSync(zipPath), 'Test zip dosyası mevcut olmalı');

    const zipFiles = await TakeoutScanner.scan(zipPath);
    assert.ok(zipFiles.length >= 2, 'ZIP içerisinden en az 2 medya okunmalı');

    // Normal Zipli Dosya ve JSON okuma
    const zippedImage = zipFiles.find(f => f.name === 'photo_inside_zip.jpg');
    assert.ok(zippedImage, 'ZIP içindeki photo_inside_zip.jpg bulunmalı');
    assert.equal(zippedImage.isZip, true);
    const zipMeta = await TakeoutScanner.parseMetadata(zippedImage);
    assert.equal(zipMeta.description, 'ZIP içinden okunan fotoğraf', 'ZIP içindeki JSON bellekte okunmalı');

    // ZIP içi Live Photo çifti (zip_live.jpg + zip_live.mp4)
    const zippedLive = zipFiles.find(f => f.name === 'zip_live.jpg');
    assert.ok(zippedLive, 'ZIP içindeki zip_live.jpg bulunmalı');
    assert.equal(zippedLive.isLivePhoto, true, 'ZIP içindeki Live Photo çifti otomatik eşleşmeli');
    assert.equal(zippedLive.livePhotoVideoName, 'zip_live.mp4');

    // ZIP içerisinden Immich'e stream upload testi
    const client = new ImmichClient(`http://localhost:${mockServerPort}`, 'test-valid-key');
    let streamedBytes = 0;
    const res = await client.uploadAsset(zippedImage, zipMeta, (chunkLen) => {
      streamedBytes += chunkLen;
    });

    assert.equal(res.success, true, 'ZIP içindeki dosya başarıyla stream edilmeli');
    assert.ok(streamedBytes > 0, 'ZIP dosyasından veri akışı gerçekleşmeli');
  });

  // TEST 9: Hibrit Dizin ve Seçici Tarama Seçenekleri (Checkbox Filtreleme)
  test('9. Hybrid Directory & Selective Filters: Extracted, ZIP ve Live Photo toggle seçenekleri', async () => {
    // TEST_TAKEOUT_DIR içine bir zip kopyalayalım (Böylece hem loose dosyalar hem .zip aynı dizinde olur)
    const hybridZipDest = path.join(TEST_TAKEOUT_DIR, 'nested_archive.zip');
    fs.copyFileSync(path.join(TEST_DIR, 'test_takeout.zip'), hybridZipDest);

    // 1. Durum: Hem Extracted hem ZIP açık (Varsayılan)
    const allResults = await TakeoutScanner.scan(TEST_TAKEOUT_DIR, {
      scanExtracted: true,
      scanZips: true,
      pairLivePhotos: true
    });
    const hasLoose = allResults.some(f => !f.isZip);
    const hasZip = allResults.some(f => f.isZip);
    assert.ok(hasLoose, 'Normal klasör dosyaları bulunmalı');
    assert.ok(hasZip, 'ZIP içi dosyalar bulunmalı');

    // 2. Durum: Sadece ZIP açık, Extracted kapalı
    const onlyZips = await TakeoutScanner.scan(TEST_TAKEOUT_DIR, {
      scanExtracted: false,
      scanZips: true
    });
    assert.ok(onlyZips.length > 0, 'ZIP içi dosyalar taranmalı');
    assert.ok(onlyZips.every(f => f.isZip), 'Tüm sonuçlar ZIP içinden olmalı');

    // 3. Durum: Sadece Extracted açık, ZIP kapalı
    const onlyExtracted = await TakeoutScanner.scan(TEST_TAKEOUT_DIR, {
      scanExtracted: true,
      scanZips: false
    });
    assert.ok(onlyExtracted.length > 0, 'Normal dosyalar taranmalı');
    assert.ok(onlyExtracted.every(f => !f.isZip), 'Hiçbir sonuç ZIP olmamalı');

    // 4. Durum: pairLivePhotos: false olduğunda heic ve mov ayrı ayrı listelenmeli
    const unpairResults = await TakeoutScanner.scan(TEST_TAKEOUT_DIR, {
      scanExtracted: true,
      scanZips: false,
      pairLivePhotos: false
    });
    const heic = unpairResults.find(f => f.name === 'apple_live.heic');
    const mov = unpairResults.find(f => f.name === 'apple_live.mov');
    assert.ok(heic, 'apple_live.heic bulunmalı');
    assert.ok(mov, 'apple_live.mov bağımsız dosya olarak bulunmalı');
    assert.equal(heic.isLivePhoto, false, 'Live photo eşlenmemiş olmalı');

    // 5. Migrator scan breakdown testi
    const checkMgr = new CheckpointManager(TEST_CHECKPOINT_DIR);
    const migrator = new Migrator(checkMgr);
    const stats = await migrator.scan(TEST_TAKEOUT_DIR, {
      scanExtracted: true,
      scanZips: true,
      pairLivePhotos: true
    });

    assert.ok(stats.extractedCount > 0, 'extractedCount > 0 olmalı');
    assert.ok(stats.zipCount > 0, 'zipCount > 0 olmalı');
    assert.ok(stats.livePhotoCount > 0, 'livePhotoCount > 0 olmalı');
    assert.equal(stats.totalFiles, stats.extractedCount + stats.zipCount);
  });

  // TEST 10: Akıllı Tarih Kurtarma (Filename Regex & creationTime fallback)
  test('10. Metadata Recovery: Dosya adı regex ve alternatif creationTime fallbackleri', async () => {
    // 1. Kamera standart formatı (IMG_20220815_143022)
    const d1 = TakeoutScanner.extractDateFromFilename('IMG_20220815_143022.jpg');
    assert.ok(d1, 'IMG formatından tarih okunmalı');
    assert.equal(d1.toISOString(), '2022-08-15T14:30:22.000Z');

    // 2. WhatsApp formatı (IMG-20230514-WA0002)
    const d2 = TakeoutScanner.extractDateFromFilename('IMG-20230514-WA0002.jpeg');
    assert.ok(d2, 'WhatsApp formatından tarih okunmalı');
    assert.equal(d2.toISOString().slice(0, 10), '2023-05-14');

    // 3. Ekran Görüntüsü formatı (Screenshot_2021-09-10-18-30-00)
    const d3 = TakeoutScanner.extractDateFromFilename('Screenshot_2021-09-10-18-30-00.png');
    assert.ok(d3, 'Screenshot formatından tarih okunmalı');
    assert.equal(d3.toISOString(), '2021-09-10T18:30:00.000Z');

    // 4. Epoch milisaniye formatı (1622505600000.jpg -> 2021-06-01)
    const d4 = TakeoutScanner.extractDateFromFilename('1622505600000.jpg');
    assert.ok(d4, 'Epoch timestamp formatından tarih okunmalı');
    assert.equal(d4.toISOString(), '2021-06-01T00:00:00.000Z');

    // 5. JSON yan dosyası olmayan ama dosya adında tarihi olan bir dosya:
    // mtime bugün olsa bile dosya adındaki gerçek tarih atanmalı!
    const todayMtime = new Date();
    const fallbackItem = {
      name: 'IMG_20200315_091530.jpg',
      fullPath: '/non/existent/path/IMG_20200315_091530.jpg',
      mtime: todayMtime,
      isZip: false
    };
    const metaFallback = await TakeoutScanner.parseMetadata(fallbackItem);
    assert.equal(metaFallback.createdAt, '2020-03-15T09:15:30.000Z', 'JSON bulunamadığında dosya adındaki gerçek tarih atanmalı');

    // 6. JSON'da photoTakenTime yoksa creationTime.timestamp okunmalı
    const jsonWithoutPhotoTakenTime = JSON.stringify({
      title: 'no_photo_taken.jpg',
      creationTime: {
        timestamp: '1577836800' // 2020-01-01T00:00:00Z
      }
    });
    const metaCreation = await TakeoutScanner.parseMetadata({
      name: 'no_photo_taken.jpg',
      jsonContent: jsonWithoutPhotoTakenTime,
      mtime: todayMtime
    });
    assert.equal(metaCreation.createdAt, '2020-01-01T00:00:00.000Z', 'creationTime fallback doğru çalışmalı');
  });

  // TEST 11: Otomatik Sınıflandırma (MediaOrganizer: uploaded, duplicates, errors)
  test('11. MediaOrganizer: uploaded, duplicates ve errors klasörleme ve hata raporlama', async () => {
    const orgOutDir = path.join(TEST_DIR, 'organizer_output');
    const organizer = new MediaOrganizer(orgOutDir, { action: 'copy', enabled: true });

    // 1. Başarılı aktarım (uploaded) testi
    const samplePhoto = path.join(TEST_DIR, 'organizer_test_photo.jpg');
    fs.writeFileSync(samplePhoto, 'sample photo binary data');
    const sampleJson = path.join(TEST_DIR, 'organizer_test_photo.jpg.json');
    fs.writeFileSync(sampleJson, JSON.stringify({ description: 'Organize test' }));

    const itemSuccess = {
      isZip: false,
      fullPath: samplePhoto,
      name: 'organizer_test_photo.jpg',
      size: 25,
      isLivePhoto: false
    };

    const resUploaded = await organizer.organize(itemSuccess, 'uploaded');
    assert.ok(resUploaded, 'Uploaded organizasyonu başarılı dönmeli');
    assert.ok(fs.existsSync(path.join(orgOutDir, 'uploaded', 'organizer_test_photo.jpg')), 'uploaded/ içine dosya kopyalanmalı');
    assert.ok(fs.existsSync(path.join(orgOutDir, 'uploaded', 'organizer_test_photo.jpg.json')), 'uploaded/ içine JSON kopyalanmalı');

    // 2. Mükerrer aktarım (duplicates) testi
    const resDup = await organizer.organize(itemSuccess, 'duplicates');
    assert.ok(resDup, 'Duplicate organizasyonu başarılı dönmeli');
    assert.ok(fs.existsSync(path.join(orgOutDir, 'duplicates', 'organizer_test_photo.jpg')), 'duplicates/ içine dosya kopyalanmalı');

    // 3. Hatalı aktarım (errors) testi ve .error.txt açıklaması
    const resErr = await organizer.organize(itemSuccess, 'errors', 'Immich HTTP 413: Payload Too Large');
    assert.ok(resErr, 'Error organizasyonu başarılı dönmeli');
    assert.ok(fs.existsSync(path.join(orgOutDir, 'errors', 'organizer_test_photo.jpg')), 'errors/ içine dosya kopyalanmalı');
    
    const errLogPath = path.join(orgOutDir, 'errors', 'organizer_test_photo.jpg.error.txt');
    assert.ok(fs.existsSync(errLogPath), 'errors/ içine .error.txt oluşturulmalı');
    const errText = fs.readFileSync(errLogPath, 'utf8');
    assert.ok(errText.includes('Immich HTTP 413: Payload Too Large'), 'Hata mesajı raporda bulunmalı');

    // 4. ZIP içindeki dosyanın organizer ile çıkarılması
    const zipPath = path.join(TEST_DIR, 'test_takeout.zip');
    const zipItem = {
      isZip: true,
      zipPath,
      entryName: 'photo_inside_zip.jpg',
      name: 'photo_inside_zip.jpg',
      size: 100,
      jsonContent: JSON.stringify({ title: 'zip photo' }),
      isLivePhoto: false
    };

    const resZipOrg = await organizer.organize(zipItem, 'uploaded');
    assert.ok(resZipOrg, 'ZIP içi dosya başarıyla çıkarılmalı');
    assert.ok(fs.existsSync(path.join(orgOutDir, 'uploaded', 'photo_inside_zip.jpg')), 'ZIP içindeki dosya uploaded klasörüne çıkarılmalı');
  });

  // TEST 12: Rescan Protection (uploaded, duplicates ve _organized dizinlerinin taranmaması)
  test('12. Rescan Protection: uploaded/ klasörünün ve ayrıştırılmış dizinlerin yeniden taranmasını engelleme', async () => {
    const parentFolder = path.join(TEST_DIR, 'protection_test');
    const normalSub = path.join(parentFolder, 'normal_photos');
    const uploadedSub = path.join(parentFolder, 'uploaded');
    const duplicatesSub = path.join(parentFolder, 'duplicates');
    const organizedFolder = path.join(parentFolder, 'archive_organized');

    fs.mkdirSync(normalSub, { recursive: true });
    fs.mkdirSync(uploadedSub, { recursive: true });
    fs.mkdirSync(duplicatesSub, { recursive: true });
    fs.mkdirSync(organizedFolder, { recursive: true });

    fs.writeFileSync(path.join(normalSub, 'valid_to_scan.jpg'), '123');
    fs.writeFileSync(path.join(uploadedSub, 'should_never_scan_this.jpg'), '456');
    fs.writeFileSync(path.join(duplicatesSub, 'also_never_scan.jpg'), '789');
    fs.writeFileSync(path.join(organizedFolder, 'ignored_organized.jpg'), 'abc');

    // 1. Üst dizin tarandığında sadece normal_photos içindeki bulunmalı
    const scanned = await TakeoutScanner.scan(parentFolder);
    assert.equal(scanned.length, 1, 'Yalnızca normal_photos taranmalı, uploaded ve _organized atlanmalı');
    assert.equal(scanned[0].name, 'valid_to_scan.jpg');

    // 2. Doğrudan 'uploaded' klasörü hedeflenirse tarama engellenmeli
    const directlyScannedUploaded = await TakeoutScanner.scan(uploadedSub);
    assert.equal(directlyScannedUploaded.length, 0, 'uploaded klasörü doğrudan seçildiğinde taranmamalı');
  });
});
