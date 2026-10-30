const { google } = require('googleapis');
const yauzl = require('yauzl');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

class GoogleDriveService {
  /**
   * @param {string} clientId - Google Cloud OAuth Client ID
   * @param {string} clientSecret - Google Cloud OAuth Client Secret
   * @param {string} redirectUri - OAuth Callback URL (örn: http://localhost:3000/auth/google/callback)
   */
  constructor(clientId, clientSecret, redirectUri) {
    this.clientId = clientId || process.env.GOOGLE_CLIENT_ID;
    this.clientSecret = clientSecret || process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = redirectUri || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

    if (this.clientId && this.clientSecret) {
      this.oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
    } else {
      this.oauth2Client = null;
    }

    this.tokens = null;
    this.drive = null;
  }

  /**
   * Google OAuth 2.0 oturum açma yetkilendirme bağlantısını üretir
   */
  getAuthUrl() {
    if (!this.oauth2Client) {
      throw new Error('Google Client ID ve Client Secret yapılandırılmamış!');
    }

    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: SCOPES
    });
  }

  /**
   * OAuth dönüş kodunu (code) kalıcı token'lar ile takas eder
   */
  async exchangeCode(code) {
    if (!this.oauth2Client) {
      throw new Error('OAuth2 İstemcisi başlatılmamış.');
    }

    const { tokens } = await this.oauth2Client.getToken(code);
    this.setCredentials(tokens);

    // Kullanıcı profil bilgisini çek
    const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    return {
      tokens,
      user: userInfo.data
    };
  }

  /**
   * İstemciye hazır token'ları yükler
   */
  setCredentials(tokens) {
    this.tokens = tokens;
    if (this.oauth2Client) {
      this.oauth2Client.setCredentials(tokens);
      this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    }
  }

  /**
   * Google Drive'da Takeout zip arşivlerini arar ve listeler
   */
  async listTakeoutArchives() {
    if (!this.drive) throw new Error('Google Drive bağlantısı aktif değil.');

    const res = await this.drive.files.list({
      q: "trashed = false and (mimeType = 'application/zip' or name contains 'takeout' or name contains '.zip')",
      fields: 'files(id, name, size, mimeType, modifiedTime, webViewLink, parents)',
      pageSize: 50,
      orderBy: 'modifiedTime desc'
    });

    const files = res.data.files || [];
    return files.map(f => ({
      id: f.id,
      name: f.name,
      size: parseInt(f.size || '0', 10),
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
      mimeType: f.mimeType
    }));
  }

  /**
   * Google Drive üzerindeki bir dosyanın boyutunu ve meta verilerini alır
   */
  async getFileMetadata(fileId) {
    if (!this.drive) throw new Error('Google Drive bağlantısı aktif değil.');

    const res = await this.drive.files.get({
      fileId,
      fields: 'id, name, size, mimeType, md5Checksum'
    });
    return {
      id: res.data.id,
      name: res.data.name,
      size: parseInt(res.data.size || '0', 10),
      mimeType: res.data.mimeType
    };
  }

  /**
   * Google Drive üzerindeki bir dosyadan belirli bir byte aralığını (HTTP Range) çeker
   * Bu sayede devasa ZIP arşivini indirmeden sadece başlıkları okuyabiliriz!
   */
  async getByteRange(fileId, start, end) {
    if (!this.drive) throw new Error('Google Drive bağlantısı aktif değil.');

    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      {
        headers: {
          Range: `bytes=${start}-${end}`
        },
        responseType: 'arraybuffer'
      }
    );
    return Buffer.from(res.data);
  }

  /**
   * Google Drive üzerindeki dosyanın canlı stream nesnesini döner
   */
  async getFileStream(fileId) {
    if (!this.drive) throw new Error('Google Drive bağlantısı aktif değil.');

    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    return res.data;
  }

  /**
   * Uzaktaki Google Drive ZIP dosyasını diske indirmeden,
   * yauzl HTTP Range RandomAccessReader ile bellek üzerinden okur.
   */
  async openRemoteZipReader(fileId) {
    const meta = await this.getFileMetadata(fileId);
    const totalSize = meta.size;
    const self = this;

    class RemoteZipRandomAccessReader extends yauzl.RandomAccessReader {
      _readStreamForRange(start, end) {
        // yauzl end değerini exclusive kabul eder, HTTP Range ise inclusive
        const actualEnd = end - 1;
        const passThrough = new (require('stream').PassThrough)();

        self.getByteRange(fileId, start, actualEnd)
          .then(buffer => {
            passThrough.end(buffer);
          })
          .catch(err => {
            passThrough.emit('error', err);
          });

        return passThrough;
      }
    }

    const reader = new RemoteZipRandomAccessReader();

    return new Promise((resolve, reject) => {
      yauzl.fromRandomAccessReader(reader, totalSize, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
        if (err) return reject(err);
        resolve({ zipfile, metadata: meta });
      });
    });
  }
}

module.exports = GoogleDriveService;
