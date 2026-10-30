const assert = require('assert');
const CurlParser = require('../src/curl-parser');

console.log('🧪 Google Takeout Cloud Stream & CurlParser Testleri Başlatılıyor...\n');

let passedTests = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exit(1);
  }
}

// 1. Düz URL Ayrıştırma Testi
runTest('Düz Takeout indirme URL dizgesi başarıyla ayrıştırılmalıdır', () => {
  const rawUrl = 'https://takeout-download.usercontent.google.com/download/takeout-20261030.zip?authuser=0';
  const result = CurlParser.parse(rawUrl);

  assert.strictEqual(result.url, rawUrl);
  assert.strictEqual(result.method, 'GET');
  assert.ok(result.headers['User-Agent'], 'Varsayılan User-Agent atanmalı');
});

// 2. Standart Bash "Copy as cURL" Komutu Ayrıştırma
runTest('Bash / macOS Chrome Copy as cURL komutu header ve çerezleri eksiksiz ayrıştırmalıdır', () => {
  const curlCmd = `curl 'https://takeout-download.usercontent.google.com/download/takeout.zip' \\
  -H 'accept: text/html,application/xhtml+xml' \\
  -H 'cookie: __Secure-1PSID=test_cookie_123; SIDCC=test_sidcc_456' \\
  -H 'user-agent: Mozilla/5.0 Chrome/120.0' \\
  --compressed`;

  const result = CurlParser.parse(curlCmd);

  assert.strictEqual(result.url, 'https://takeout-download.usercontent.google.com/download/takeout.zip');
  assert.strictEqual(result.headers['accept'], 'text/html,application/xhtml+xml');
  assert.strictEqual(result.headers['cookie'], '__Secure-1PSID=test_cookie_123; SIDCC=test_sidcc_456');
  assert.strictEqual(result.headers['user-agent'], 'Mozilla/5.0 Chrome/120.0');
});

// 3. Windows PowerShell cURL Komutu Ayrıştırma
runTest('Windows PowerShell (ters tırnak kaçışlı) cURL komutunu desteklemelidir', () => {
  const psCurl = `curl.exe "https://takeout-download.usercontent.google.com/download/takeout-ps.zip" \`
  -H "Cookie: HSID=abc789; SSID=xyz123" \`
  -H "Referer: https://takeout.google.com/"`;

  const result = CurlParser.parse(psCurl);

  assert.strictEqual(result.url, 'https://takeout-download.usercontent.google.com/download/takeout-ps.zip');
  assert.strictEqual(result.headers['Cookie'], 'HSID=abc789; SSID=xyz123');
  assert.strictEqual(result.headers['Referer'], 'https://takeout.google.com/');
});

// 4. -b / --cookie parametre desteği
runTest('-b ve --cookie argümanlarını doğru algılamalıdır', () => {
  const cookieCmd = `curl 'https://takeout-download.usercontent.google.com/test.zip' --cookie 'SESSIONID=abcdef'`;
  const result = CurlParser.parse(cookieCmd);

  assert.strictEqual(result.headers['Cookie'], 'SESSIONID=abcdef');
});

// 5. Geçersiz girdi hata koruması
runTest('Boş veya geçersiz bağlantıda temiz hata fırlatmalıdır', () => {
  assert.throws(() => {
    CurlParser.parse('');
  }, /Geçersiz veya boş cURL girdisi/);

  assert.throws(() => {
    CurlParser.parse('echo "hello world"');
  }, /HTTP\/HTTPS bağlantısı bulunamadı/);
});

console.log(`\n🎉 Tüm CurlParser Testleri Başarıyla Geçti! (${passedTests} test)\n`);
