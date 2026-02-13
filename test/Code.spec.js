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

    // Mock XmlService
    global.XmlService = {
      parse: vi.fn((xml) => {
        // Very simple mock for the RSS structure
        const items = [];
        if (xml.includes('<item>')) {
          const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          itemMatches.forEach(itemXml => {
            const title = itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
            const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
            const description = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
            items.push({
              getChildText: (name) => {
                if (name === 'title') return title;
                if (name === 'pubDate') return pubDate;
                if (name === 'description') return description;
                return '';
              }
            });
          });
        }

        return {
          getRootElement: () => ({
            getChild: (name) => {
              if (name === 'channel') {
                return {
                  getChildren: (childName) => {
                    if (childName === 'item') return items;
                    return [];
                  }
                };
              }
              return null;
            }
          })
        };
      })
    };

    // Mock Logger
    global.Logger = {
      log: vi.fn(),
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
        getFilesByType: vi.fn(() => createMockFiles(mockFiles)),
        getFiles: vi.fn(() => createMockFiles(mockFiles)),
      })),
    };
  });

  describe('getAllXmlDataEntries_', () => {
    it('should retrieve and parse mfcf.YYYYMM.xml files in descending order', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202601.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>01/01(木) -¥1,000 TEST1</title>
      <pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: 01/01(木) amount: -¥1,000 category: Category1 is_transfer: false ]]></description>
    </item>
  </channel>
</rss>`
          })
        },
        {
          getName: () => 'mfcf.202602.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>02/12(木) -¥3,000 DF.トウキユウカ-ド</title>
      <pubDate>Thu, 12 Feb 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: 02/12(木) amount: -¥3,000 category: 現金・カード/カード引き落とし is_transfer: false ]]></description>
    </item>
    <item>
      <title>02/11(水) +¥5,000 Transfer</title>
      <pubDate>Wed, 11 Feb 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: 02/11(水) amount: +¥5,000 category: 振替 is_transfer: true ]]></description>
    </item>
  </channel>
</rss>`
          })
        },
        {
          getName: () => 'ignore.me.xml',
          getBlob: () => ({ getDataAsString: () => '' })
        }
      ];

      const createMockFiles = (filesArray) => {
        let index = 0;
        return {
          hasNext: vi.fn(() => index < filesArray.length),
          next: vi.fn(() => filesArray[index++]),
        };
      };

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();

      // Should be 202602 items first, then 202601 items
      expect(result.length).toBe(3);

      // 202602 items
      expect(result[0].date).toBe('2026-02-12');
      expect(result[0].amount).toBe(-3000);
      expect(result[0].name).toBe('DF.トウキユウカ-ド');
      expect(result[0].category).toBe('現金・カード/カード引き落とし');
      expect(result[0].is_transfer).toBe(false);

      expect(result[1].date).toBe('2026-02-11');
      expect(result[1].amount).toBe(5000);
      expect(result[1].name).toBe('Transfer');
      expect(result[1].category).toBe('振替');
      expect(result[1].is_transfer).toBe(true);

      // 202601 item
      expect(result[2].date).toBe('2026-01-01');
      expect(result[2].amount).toBe(-1000);
    });

    it('should handle invalid XML gracefully', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202601.xml',
          getBlob: () => ({
            getDataAsString: () => 'invalid xml'
          })
        }
      ];

      const createMockFiles = (filesArray) => {
        let index = 0;
        return {
          hasNext: vi.fn(() => index < filesArray.length),
          next: vi.fn(() => filesArray[index++]),
        };
      };

      global.XmlService.parse.mockImplementationOnce(() => {
        throw new Error('Parse error');
      });

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result).toEqual([]);
      expect(global.Logger.log).toHaveBeenCalledWith(expect.stringContaining('Failed to process file mfcf.202601.xml: Parse error'));
    });
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
        mfcf: [],
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
      const csvPayload = JSON.stringify({ assetClassRatio: [{ cached: true }] });
      const mfcfKeys = JSON.stringify(['mfcf.202401']);
      const xmlPayload = JSON.stringify([{ date: '2024-01-01', amount: 100 }]);
      const cache = global.CacheService.getScriptCache();
      cache.get.mockImplementation((key) => {
        if (key === '0') return csvPayload;
        if (key === 'mfcf') return mfcfKeys;
        if (key === 'mfcf.202401') return xmlPayload;
        return null;
      });

      Code.doGet({ parameter: {} });

      expect(cache.get).toHaveBeenCalledWith('0');
      expect(cache.get).toHaveBeenCalledWith('mfcf');
      expect(cache.get).toHaveBeenCalledWith('mfcf.202401');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        assetClassRatio: [{ cached: true }],
        mfcf: [{ date: '2024-01-01', amount: 100 }],
      }));
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
        mfcf: [],
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
        mfcf: [],
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
        cachedKeys: ['0', 'mfcf'],
      }));
    });
  });


  describe('preCacheAll', () => {
    it('should clear old keys, put all partitions and master key list', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202601.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>01/01(木) -¥1,000 TEST1</title>
      <pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: 01/01(木) amount: -¥1,000 category: Category1 is_transfer: false ]]></description>
    </item>
  </channel>
</rss>`
          })
        }
      ];

      const createMockFiles = (filesArray) => {
        let index = 0;
        return {
          hasNext: vi.fn(() => index < filesArray.length),
          next: vi.fn(() => filesArray[index++]),
        };
      };

      const folderMock = {
        getFilesByType: vi.fn(() => createMockFiles([])),
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles)),
      };
      global.DriveApp.getFolderById.mockReturnValue(folderMock);

      const cache = global.CacheService.getScriptCache();
      cache.get.mockImplementation((key) => {
        if (key === 'mfcf') return JSON.stringify(['mfcf.old']);
        return null;
      });

      const result = Code.preCacheAll();

      expect(cache.removeAll).toHaveBeenCalledWith(['mfcf.old']);
      expect(cache.removeAll).toHaveBeenCalledWith(['0', 'mfcf']);

      expect(cache.put).toHaveBeenCalledWith('0', expect.any(String), 21600);
      expect(cache.put).toHaveBeenCalledWith('mfcf', JSON.stringify(['mfcf.202601']), 21600);
      expect(cache.put).toHaveBeenCalledWith('mfcf.202601', expect.stringContaining('TEST1'), 21600);

      expect(result.status).toBe(true);
      expect(result.cachedKeys).toContain('0');
      expect(result.cachedKeys).toContain('mfcf');
      expect(result.cachedKeys).toContain('mfcf.202601');
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
