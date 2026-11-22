import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DUMMY_FAMILY_CONFIG, DUMMY_FAMILY_CONFIG_JSON } from './dummyFamilyConfig.js';

// Tests for action=family_config and getFamilyConfig_.
// The module caches the parsed config per execution, so every
// test imports a fresh module instance (vi.resetModules) to
// control the script property it sees.
describe('family config', () => {
  let scriptProperties;
  let filesByName;
  let uuidCounter;

  const lastJson = () => JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);

  const importCode = async () => {
    vi.resetModules();
    return import('../src/Code.js');
  };

  beforeEach(() => {
    vi.resetAllMocks();
    uuidCounter = 0;
    filesByName = {};

    scriptProperties = {
      DEBUG: 'false',
      NO_CACHE: 'false',
      AVAILABLE_GMAILS: 'allowed@example.com',
      GOOGLE_OAUTH_CLIENT_ID: 'client-id',
      FAMILY_CONFIG_JSON: DUMMY_FAMILY_CONFIG_JSON,
    };

    global.PropertiesService = {
      getScriptProperties: vi.fn(() => ({
        getProperty: vi.fn((key) => scriptProperties[key] ?? ''),
        setProperty: vi.fn((key, value) => {
          scriptProperties[key] = String(value);
        }),
      })),
    };

    global.UrlFetchApp = {
      fetch: vi.fn(() => ({
        getResponseCode: () => 200,
        getContentText: () =>
          JSON.stringify({
            iss: 'accounts.google.com',
            aud: 'client-id',
            exp: `${Math.floor(Date.now() / 1000) + 3600}`,
            email_verified: 'true',
            email: 'allowed@example.com',
            sub: 'sub-id',
          }),
      })),
    };

    global.MimeType = { CSV: 'text/csv' };

    const mockTextOutput = {
      setMimeType: vi.fn().mockReturnThis(),
      getContent: vi.fn(),
    };
    global.ContentService = {
      MimeType: { JSON: 'application/json' },
      createTextOutput: vi.fn().mockReturnValue(mockTextOutput),
    };

    const mockCache = { get: vi.fn(() => null), removeAll: vi.fn(), put: vi.fn() };
    global.CacheService = { getScriptCache: vi.fn(() => mockCache) };

    global.Utilities = {
      parseCsv: vi.fn((csv) => {
        if (!csv) return [[]];
        return csv
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => line.split(','));
      }),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: vi.fn((algo, str) =>
        Array.from({ length: 32 }, (_, i) => String(str).charCodeAt(i % String(str).length) % 128)),
      getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
    };

    global.Logger = { log: vi.fn() };

    const makeFile = (name) => ({
      getName: vi.fn(() => name),
      getMimeType: vi.fn(() => 'application/json'),
      getBlob: vi.fn(() => ({ getDataAsString: vi.fn(() => filesByName[name]) })),
      setContent: vi.fn((content) => {
        filesByName[name] = content;
      }),
    });
    const iteratorOf = (files) => {
      let index = 0;
      return { hasNext: () => index < files.length, next: () => files[index++] };
    };
    const mockFolder = {
      getFiles: vi.fn(() => iteratorOf([])),
      getFilesByName: vi.fn((name) => iteratorOf(filesByName[name] != null ? [makeFile(name)] : [])),
      createFile: vi.fn((name, content) => {
        filesByName[name] = content;
        return makeFile(name);
      }),
    };
    global.DriveApp = { getFolderById: vi.fn(() => mockFolder) };
  });

  it('returns the config to an ID-token-authorized caller', async () => {
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'family_config' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    expect(lastJson()).toEqual(DUMMY_FAMILY_CONFIG);
  });

  it('rejects a caller with no credentials', async () => {
    const Code = await importCode();
    Code.doGet({ parameter: { action: 'family_config' }, headers: {} });
    expect(lastJson()).toEqual({ status: 401, error: 'missing id token' });
  });

  it('rejects a caller whose email is not allowed', async () => {
    const Code = await importCode();
    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 200,
      getContentText: () =>
        JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: 'true',
          email: 'other@example.com',
          sub: 'sub-id',
        }),
    });
    Code.doGet({
      parameter: { action: 'family_config' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    expect(lastJson()).toEqual({ status: 403, error: 'forbidden email' });
  });

  it('returns the config to a share-token holder', async () => {
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'issue_share' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    const shareToken = lastJson().share_token;
    expect(shareToken).toBeTruthy();

    Code.doGet({ parameter: { action: 'family_config', share_token: shareToken }, headers: {} });
    expect(lastJson()).toEqual(DUMMY_FAMILY_CONFIG);
  });

  it('rejects an unknown share token', async () => {
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'family_config', share_token: 'no-such-token' },
      headers: {},
    });
    expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
  });

  it('returns the config to an owner-session holder', async () => {
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'exchange_session' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    const sessionToken = lastJson().session_token;
    expect(sessionToken).toBeTruthy();

    Code.doGet({
      parameter: { action: 'family_config', session_token: sessionToken },
      headers: {},
    });
    expect(lastJson()).toEqual(DUMMY_FAMILY_CONFIG);
  });

  it('fails closed when the property is missing', async () => {
    delete scriptProperties.FAMILY_CONFIG_JSON;
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'family_config' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    expect(lastJson()).toEqual({ status: 401, error: 'family config is not configured' });
  });

  it('fails closed when the property is not valid JSON', async () => {
    scriptProperties.FAMILY_CONFIG_JSON = '{not json';
    const Code = await importCode();
    Code.doGet({
      parameter: { action: 'family_config' },
      headers: { Authorization: 'Bearer dummy-token' },
    });
    expect(lastJson()).toEqual({ status: 401, error: 'family config is invalid' });
  });

  it('getFamilyConfig_ throws for missing, malformed and non-object values', async () => {
    let Code = await importCode();
    expect(Code.getFamilyConfig_()).toEqual(DUMMY_FAMILY_CONFIG);

    delete scriptProperties.FAMILY_CONFIG_JSON;
    Code = await importCode();
    expect(() => Code.getFamilyConfig_()).toThrow('family config is not configured');

    scriptProperties.FAMILY_CONFIG_JSON = '[1,2]';
    Code = await importCode();
    expect(() => Code.getFamilyConfig_()).toThrow('family config is invalid');
  });
});
