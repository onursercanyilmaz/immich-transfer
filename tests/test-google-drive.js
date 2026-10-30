const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const GoogleDriveService = require('../src/google-drive');

describe('Google Drive Cloud Connect & Stream Service', () => {
  test('1. GoogleDriveService: Yapılandırma ve Auth URL üretimi', () => {
    const dummyClientId = '123456789-dummy.apps.googleusercontent.com';
    const dummyClientSecret = 'GOCSPX-dummy-secret';
    const redirectUri = 'http://localhost:3000/auth/google/callback';

    const service = new GoogleDriveService(dummyClientId, dummyClientSecret, redirectUri);
    assert.equal(service.clientId, dummyClientId);
    assert.equal(service.clientSecret, dummyClientSecret);

    const authUrl = service.getAuthUrl();
    assert.ok(authUrl.startsWith('https://accounts.google.com/o/oauth2/v2/auth'));
    assert.ok(authUrl.includes('drive.readonly'), 'drive.readonly izni bulunmalı');
    assert.ok(authUrl.includes('userinfo.email'), 'userinfo.email izni bulunmalı');
  });

  test('2. GoogleDriveService: Eksik kimlik bilgisi koruması', () => {
    const emptyService = new GoogleDriveService('', '', '');
    assert.throws(
      () => emptyService.getAuthUrl(),
      /Google Client ID ve Client Secret yapılandırılmamış/
    );
  });

  test('3. GoogleDriveService: Yetkisiz arama koruması', async () => {
    const dummyService = new GoogleDriveService('client-id', 'client-secret');
    await assert.rejects(
      async () => await dummyService.listTakeoutArchives(),
      /Google Drive bağlantısı aktif değil/
    );
  });
});
