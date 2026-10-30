/**
 * cURL Komut Ayrıştırıcısı (cURL Command & URL Parser)
 * 
 * Tarayıcıdan (Chrome/Firefox/Edge/Safari) kopyalanan "Copy as cURL" komutlarını
 * veya doğrudan URL dizgelerini temiz bir HTTP istek yapılandırmasına dönüştürür.
 */

class CurlParser {
  /**
   * cURL komut metnini veya URL'yi ayrıştırır
   * @param {string} rawInput - Kullanıcının yapıştırdığı metin
   * @returns {{ url: string, headers: Object, method: string }}
   */
  static parse(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') {
      throw new Error('Geçersiz veya boş cURL girdisi.');
    }

    const trimmed = rawInput.trim();

    // 1. Durum: Kullanıcı sadece düz bir URL yapıştırdıysa
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = trimmed.split(/\s+/)[0];
      return {
        url,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      };
    }

    // 2. Durum: Standart 'curl' komutu yapıştırıldıysa
    const headers = {};
    let url = '';
    let method = 'GET';

    // Windows cmd, PowerShell veya Bash çoklu satır kaçışlarını (\ veya `) temizle
    const normalized = trimmed.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');

    // URL ayıklama: curl 'URL' veya curl "URL" veya curl URL
    const urlMatch = normalized.match(/curl\s+(?:--location\s+|--compressed\s+)?['"]?(https?:\/\/[^\s'"]+)['"]?/i) ||
                     normalized.match(/['"]?(https?:\/\/[^\s'"]+)['"]?/);

    if (urlMatch) {
      url = urlMatch[1];
    } else {
      throw new Error('cURL komutu içerisinde geçerli bir HTTP/HTTPS bağlantısı bulunamadı.');
    }

    // Header (-H veya --header) ayıklama
    const headerRegex = /(?:-H|--header)\s+['"]([^'"]+)['"]/gi;
    let match;
    while ((match = headerRegex.exec(normalized)) !== null) {
      const headerLine = match[1];
      const colonIdx = headerLine.indexOf(':');
      if (colonIdx > 0) {
        const key = headerLine.substring(0, colonIdx).trim();
        const value = headerLine.substring(colonIdx + 1).trim();
        // Bazı tehlikeli veya stream'i bozan header'ları temizle
        const keyLower = key.toLowerCase();
        if (keyLower !== 'content-length' && keyLower !== 'host') {
          headers[key] = value;
        }
      }
    }

    // Çerez (-b veya --cookie) ayıklama
    const cookieRegex = /(?:-b|--cookie)\s+['"]([^'"]+)['"]/gi;
    while ((match = cookieRegex.exec(normalized)) !== null) {
      headers['Cookie'] = match[1];
    }

    // Eğer User-Agent yoksa varsayılan modern tarayıcı kimliği ata
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    return {
      url,
      method,
      headers
    };
  }
}

module.exports = CurlParser;
