import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

describe('Code.js', () => {
  let scriptProperties;

  beforeEach(() => {
    vi.resetAllMocks();

    scriptProperties = {
      DEBUG: 'true',
      AVAILABLE_GMAILS: 'allowed@example.com',
      GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    };

    global.PropertiesService = {
      getScriptProperties: vi.fn(() => ({
        getProperty: vi.fn((key) => scriptProperties[key] ?? ''),
      })),
    };

    global.UrlFetchApp = {
      fetch: vi.fn(() => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: 'true',
          email: 'allowed@example.com',
          sub: 'sub-id',
        }),
      })),
    };

    // Mock MimeType
    global.MimeType = {
      CSV: 'text/csv',
    };

    // Mock ContentService
    const mockTextOutput = {
      setMimeType: vi.fn().mockReturnThis(),
      getContent: vi.fn(),
    };
    global.ContentService = {
      MimeType: {
        JSON: 'application/json',
      },
      createTextOutput: vi.fn().mockReturnValue(mockTextOutput),
    };

    // Mock CacheService
    const mockCache = {
      get: vi.fn(() => null),
      removeAll: vi.fn(),
      put: vi.fn(),
    };
    global.CacheService = {
      getScriptCache: vi.fn(() => mockCache),
    };

    // Mock Utilities
    global.Utilities = {
      parseCsv: vi.fn((csv) => {
        // Simple mock of CSV parsing
        if (!csv) return [[]];
        const lines = csv.split('\n').filter(line => line.trim() !== '');
        return lines.map(line => line.split(','));
      }),
    };

    // Mock DriveApp
    const mockFiles = [
      {
        getName: () => 'assetClassRatio.csv',
        getBlob: () => ({ getDataAsString: () => 'timestamp,y,other\n2023-01-01,20,val' })
      },
      {
        getName: () => 'other.CSV',
        getBlob: () => ({ getDataAsString: () => 'header1,header2\nval3,val4' })
      },
      {
        getName: () => 'breakdown-liability.csv',
        getBlob: () => ({ getDataAsString: () => 'timestamp,amount_text_num,percentage_text_num,other\n2023-01-01,100,10,val' })
      },
      {
        getName: () => 'details__liability_123.csv',
        getBlob: () => ({ getDataAsString: () => 'timestamp,detail_id,table_index,残高_yen,other\n2023-01-01,id1,0,500,val' })
      },
      {
        getName: () => 'total-liability.csv',
        getBlob: () => ({ getDataAsString: () => 'timestamp,total_text_num,other\n2023-01-01,1000,val' })
      },
      {
        getName: () => 'details__portfolio_456.csv',
        getBlob: () => ({ getDataAsString: () => 'timestamp,detail_id,table_index,other\n2023-01-01,id2,1,val' })
      }
    ];

    const createMockFiles = (filesArray) => {
      let index = 0;
      return {
        hasNext: vi.fn(() => index < filesArray.length),
        next: vi.fn(() => filesArray[index++]),
      };
    };

    global.DriveApp = {
      getFolderById: vi.fn(() => ({
        getFilesByType: vi.fn(() => createMockFiles(mockFiles))
      })),
    };
  });

  describe('doGet', () => {
    it('should return all CSV data keyed by filename when no parameters are provided', () => {
      const e = { parameter: {} };
      Code.doGet(e);

      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('19PDxxar-38XMlBiYC02lDb1bJh3wJRkh');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        assetClassRatio: [{ other: 'val', amount_yen: '20' }],
        other: [{ header1: 'val3', header2: 'val4' }],
        'breakdown-liability': [{ other: 'val' }],
        details__liability_123: [{ other: 'val' }],
        'total-liability': [{ other: 'val' }],
        details__portfolio_456: [{ other: 'val' }],
      }));
    });

    it('should return all CSV data when e is null', () => {
      Code.doGet(null);
      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
    });

    it('should return all CSV data when e.parameter is null', () => {
      Code.doGet({ parameter: null });
      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
    });


    it('should return cached all data when no parameters are provided and cache exists', () => {
      const cachePayload = JSON.stringify({ assetClassRatio: [{ cached: true }] });
      const cache = global.CacheService.getScriptCache();
      cache.get.mockImplementation((key) => (key === '0' ? cachePayload : null));

      Code.doGet({ parameter: {} });

      expect(cache.get).toHaveBeenCalledWith('0');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(cachePayload);
      expect(global.DriveApp.getFolderById).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });




    it('should fallback to folder data when CacheService is unavailable', () => {
      delete global.CacheService;

      Code.doGet({ parameter: {} });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        assetClassRatio: [{ other: 'val', amount_yen: '20' }],
        other: [{ header1: 'val3', header2: 'val4' }],
        'breakdown-liability': [{ other: 'val' }],
        details__liability_123: [{ other: 'val' }],
        'total-liability': [{ other: 'val' }],
        details__portfolio_456: [{ other: 'val' }],
      }));
    });

    it('should return status true when other parameters are provided', () => {
      const e = { parameter: { unknown: 'value' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({ status: true }));
    });

    it('should skip auth when DEBUG is true', () => {
      Code.doGet({ parameter: {} });
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('should validate auth token when DEBUG is not true', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet({
        parameter: {},
        headers: { Authorization: 'Bearer token-value' },
      });

      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/tokeninfo?id_token=token-value',
        { muteHttpExceptions: true },
      );
    });

    it('should support lowercase authorization header', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet({
        parameter: {},
        headers: { authorization: 'Bearer token-lowercase' },
      });

      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/tokeninfo?id_token=token-lowercase',
        { muteHttpExceptions: true },
      );
    });

    it('should support id_token query parameter when authorization header is missing', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet({
        parameter: { id_token: 'token-from-query' },
        headers: {},
      });

      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/tokeninfo?id_token=token-from-query',
        { muteHttpExceptions: true },
      );
    });

    it('should return all CSV data when only id_token parameter is provided', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet({
        parameter: { id_token: 'token-from-query' },
        headers: {},
      });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        assetClassRatio: [{ other: 'val', amount_yen: '20' }],
        other: [{ header1: 'val3', header2: 'val4' }],
        'breakdown-liability': [{ other: 'val' }],
        details__liability_123: [{ other: 'val' }],
        'total-liability': [{ other: 'val' }],
        details__portfolio_456: [{ other: 'val' }],
      }));
    });

    it('should return 401 when event is undefined in non-debug mode', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet(undefined);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
    });

    it('should return 401 when bearer token is missing', () => {
      scriptProperties.DEBUG = 'false';
      Code.doGet({ parameter: {}, headers: {} });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
    });

    it('should return 401 when GOOGLE_OAUTH_CLIENT_ID is missing', () => {
      scriptProperties.DEBUG = 'false';
      scriptProperties.GOOGLE_OAUTH_CLIENT_ID = '';
      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing GOOGLE_OAUTH_CLIENT_ID' }),
      );
    });

    it('should return 401 when token verification fails', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 400,
        getContentText: () => '',
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'token verification failed' }),
      );
    });

    it('should return 401 for invalid issuer', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'bad-issuer',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: 'true',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'invalid iss' }),
      );
    });

    it('should return 401 for invalid audience', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'invalid-aud',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: 'true',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'invalid aud' }),
      );
    });

    it('should return 401 for expired tokens', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) - 1}`,
          email_verified: 'true',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'token expired' }),
      );
    });

    it('should return 401 for non numeric exp', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: 'abc',
          email_verified: 'true',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'token expired' }),
      );
    });


    it('should return 401 when exp is missing', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          email_verified: 'true',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'token expired' }),
      );
    });

    it('should return 401 when email is not verified', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: 'false',
          email: 'allowed@example.com',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'email not verified' }),
      );
    });

    it('should return 401 when email is missing', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockReturnValueOnce({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          iss: 'accounts.google.com',
          aud: 'client-id',
          exp: `${Math.floor(Date.now() / 1000) + 3600}`,
          email_verified: true,
          email: '',
        }),
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing email' }),
      );
    });

    it('should return 403 for non-whitelisted email', () => {
      scriptProperties.DEBUG = 'false';
      scriptProperties.AVAILABLE_GMAILS = 'other@example.com';
      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 403, error: 'forbidden email' }),
      );
    });

    it('should allow trimmed and lower-cased whitelist entries', () => {
      scriptProperties.DEBUG = 'false';
      scriptProperties.AVAILABLE_GMAILS = '  ALLOWED@example.com  , second@example.com';
      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
    });

    it('should return unauthorized when non-Error is thrown', () => {
      scriptProperties.DEBUG = 'false';
      global.UrlFetchApp.fetch.mockImplementationOnce(() => {
        throw 'boom';
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token' } });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'unauthorized' }),
      );
    });

    it('should treat missing PropertiesService as non-debug mode', () => {
      delete global.PropertiesService;
      Code.doGet({ parameter: {}, headers: {} });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
    });

    it('should handle f=preCacheAll and bypass auth', () => {
      scriptProperties.DEBUG = 'false';
      const e = { parameter: { f: 'preCacheAll' } };
      Code.doGet(e);

      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
      expect(global.CacheService.getScriptCache).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        status: true,
        cachedKeys: ['0'],
      }));
    });
  });


  describe('preCacheAll', () => {
    it('should clear and put all cache entries with 6 hour ttl', () => {
      const result = Code.preCacheAll();
      const cache = global.CacheService.getScriptCache();

      expect(global.CacheService.getScriptCache).toHaveBeenCalled();
      expect(cache.removeAll).toHaveBeenCalledWith(['0']);

      expect(cache.put).toHaveBeenCalledWith('0', JSON.stringify({
        assetClassRatio: [{ other: 'val', amount_yen: '20' }],
        other: [{ header1: 'val3', header2: 'val4' }],
        'breakdown-liability': [{ other: 'val' }],
        details__liability_123: [{ other: 'val' }],
        'total-liability': [{ other: 'val' }],
        details__portfolio_456: [{ other: 'val' }],
      }), 21600);

      expect(cache.put).toHaveBeenCalledTimes(1);

      expect(result).toEqual({
        status: true,
        cachedKeys: ['0'],
      });
    });
  });

  describe('parseCsv_', () => {
    it('should return empty array if CSV has less than 2 lines', () => {
      expect(Code.parseCsv_('')).toEqual([]);
      expect(Code.parseCsv_('header1,header2')).toEqual([]);
    });

    it('should correctly parse CSV into JSON objects', () => {
      const csv = 'h1,h2\nv1,v2\nv3,v4';
      const result = Code.parseCsv_(csv);
      expect(result).toEqual([
        { h1: 'v1', h2: 'v2' },
        { h1: 'v3', h2: 'v4' }
      ]);
    });
  });

  describe('applyFormattingRules', () => {
    it('should return data as is if not an array', () => {
      expect(Code.applyFormattingRules(null, 'any')).toBe(null);
      expect(Code.applyFormattingRules('not array', 'any')).toBe('not array');
    });

    it('should handle assetClassRatio without y property', () => {
      const data = [{ timestamp: '2023', other: 'val' }];
      const result = Code.applyFormattingRules(data, 'assetClassRatio');
      expect(result[0]).toEqual({ other: 'val' });
      expect(result[0]).not.toHaveProperty('timestamp');
      expect(result[0]).not.toHaveProperty('y');
    });

    it('should handle unknown typeName by returning copies of items', () => {
      const data = [{ a: 1, b: 2 }];
      const result = Code.applyFormattingRules(data, 'unknown');
      expect(result).toEqual(data);
      expect(result[0]).not.toBe(data[0]); // Should be a copy
    });

    it('should apply rules for breakdown-liability', () => {
      const data = [{ timestamp: 't', amount_text_num: '1', percentage_text_num: '2', other: 'v' }];
      const result = Code.applyFormattingRules(data, 'breakdown-liability');
      expect(result[0]).toEqual({ other: 'v' });
    });


    it('should include breakdown formatting for key name breakdown', () => {
      const data = [{ timestamp: 't', amount_text_num: '1', percentage_text_num: '2', other: 'v' }];
      const result = Code.applyFormattingRules(data, 'breakdown');
      expect(result[0]).toEqual({ other: 'v' });
    });

    it('should apply rules for details__liability*', () => {
      const data = [{ timestamp: 't', detail_id: '1', table_index: '2', 残高_yen: '3', other: 'v' }];
      const result = Code.applyFormattingRules(data, 'details__liability_test');
      expect(result[0]).toEqual({ other: 'v' });
    });

    it('should apply rules for total-liability', () => {
      const data = [{ timestamp: 't', total_text_num: '1', other: 'v' }];
      const result = Code.applyFormattingRules(data, 'total-liability');
      expect(result[0]).toEqual({ other: 'v' });
    });

    it('should apply rules for details__portfolio*', () => {
      const data = [{ timestamp: 't', detail_id: '1', table_index: '2', other: 'v' }];
      const result = Code.applyFormattingRules(data, 'details__portfolio_test');
      expect(result[0]).toEqual({ other: 'v' });
    });
  });
});
