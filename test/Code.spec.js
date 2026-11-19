import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

describe('Code.js', () => {
  let scriptProperties;

  beforeEach(() => {
    vi.resetAllMocks();

    scriptProperties = {
      DEBUG: 'true',
      NO_CACHE: 'false',
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

    it('should correctly interpret MM/DD using the year from filename', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202512.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>12/25(木) -¥1,000 TEST</title>
      <pubDate>12/25</pubDate>
      <description><![CDATA[ date: 12/25(木) amount: -¥1,000 category: Category is_transfer: false ]]></description>
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

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result[0].date).toBe('2025-12-25');
    });

    it('should interpret MM/DD with leading spaces using the year from filename', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202512.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>12/25(木) -¥1,000 TEST</title>
      <pubDate>  12/25(金)  </pubDate>
      <description><![CDATA[ date: 12/25(木) amount: -¥1,000 category: Category is_transfer: false ]]></description>
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

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result[0].date).toBe('2025-12-25');
    });


    it('should prioritize explicit YYYY/MM/DD even if filename has different year', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202501.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0">
  <channel>
    <item>
      <title>12/31(火) -¥1,000 TEST</title>
      <pubDate>2024/12/31</pubDate>
      <description><![CDATA[ date: 12/31(火) amount: -¥1,000 category: Category is_transfer: false ]]></description>
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

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result[0].date).toBe('2024-12-31');
    });

    it('should prioritize transaction MM/DD over RFC822 pubDate year using filename year', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202512.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0"> 
  <channel>
    <item>
      <title>12/25(木) -¥1,000 TEST</title>
      <pubDate>Thu, 25 Dec 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: 12/25(木) amount: -¥1,000 category: Category is_transfer: false ]]></description>
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

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result[0].date).toBe('2025-12-25');
    });

    it('should fallback to RFC822 pubDate when transaction date is missing', () => {
      const mockXmlFiles = [
        {
          getName: () => 'mfcf.202601.xml',
          getBlob: () => ({
            getDataAsString: () => `
<rss version="2.0"> 
  <channel>
    <item>
      <title>NO_DATE -¥1,000 TEST</title>
      <pubDate>Thu, 25 Dec 2025 00:00:00 +0000</pubDate>
      <description><![CDATA[ amount: -¥1,000 category: Category is_transfer: false ]]></description>
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

      global.DriveApp.getFolderById.mockReturnValueOnce({
        getFiles: vi.fn(() => createMockFiles(mockXmlFiles))
      });

      const result = Code.getAllXmlDataEntries_();
      expect(result[0].date).toBe('2025-12-25');
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
    const EXPECTED_LIVE_DATA_RESPONSE = {
      assetClassRatio: [{ other: 'val', amount_yen: '20' }],
      other: [{ header1: 'val3', header2: 'val4' }],
      'breakdown-liability': [{ other: 'val' }],
      details__liability_123: [{ other: 'val' }],
      'total-liability': [{ other: 'val' }],
      details__portfolio_456: [{ other: 'val' }],
      mfcf: [],
      weights: {
        acwi: { japan: 5.08, us: 64.63, developed_other: 19.1, emerging: 11.19, other: 0, effective_date: '2026-10-30' },
        acwi_ex_japan: { japan: 0, us: 68.09, developed_other: 20.12, emerging: 11.79, other: 0, effective_date: '2026-10-30' },
        developed: { japan: 0, us: 77.19, developed_other: 22.81, emerging: 0, other: 0, effective_date: '2026-10-30' },
        emerging: { japan: 0, us: 0, developed_other: 0, emerging: 100, other: 0, effective_date: '2026-10-30' },
      },
      no_cache: true,
    };
    it('should return all CSV data keyed by filename when no parameters are provided', () => {
      const e = { parameter: {}, headers: { Authorization: 'Bearer token-value' } };
      Code.doGet(e);

      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('19PDxxar-38XMlBiYC02lDb1bJh3wJRkh');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });

    it('should return 401 when e is null', () => {
      Code.doGet(null);
      expect(global.DriveApp.getFolderById).not.toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
    });

    it('should return all CSV data when e.parameter is null', () => {
      Code.doGet({ parameter: null, headers: { Authorization: 'Bearer token-value' } });
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

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token-value' } });

      expect(cache.get).toHaveBeenCalledWith('0');
      expect(cache.get).toHaveBeenCalledWith('mfcf');
      expect(cache.get).toHaveBeenCalledWith('mfcf.202401');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({
        assetClassRatio: [{ cached: true }],
        mfcf: [{ date: '2024-01-01', amount: 100 }],
        weights: {
          acwi: { japan: 5.08, us: 64.63, developed_other: 19.1, emerging: 11.19, other: 0, effective_date: '2026-10-30' },
          acwi_ex_japan: { japan: 0, us: 68.09, developed_other: 20.12, emerging: 11.79, other: 0, effective_date: '2026-10-30' },
          developed: { japan: 0, us: 77.19, developed_other: 22.81, emerging: 0, other: 0, effective_date: '2026-10-30' },
          emerging: { japan: 0, us: 0, developed_other: 0, emerging: 100, other: 0, effective_date: '2026-10-30' },
        },
        no_cache: false,
      }));
      expect(global.DriveApp.getFolderById).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('should bypass cache reads when NO_CACHE is true', () => {
      scriptProperties.NO_CACHE = 'true';
      const cache = global.CacheService.getScriptCache();

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token-value' } });

      expect(cache.get).not.toHaveBeenCalled();
      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });

    it('should fallback to folder data when cached mfcf key list is not an array', () => {
      const cache = global.CacheService.getScriptCache();
      cache.get.mockImplementation((key) => {
        if (key === '0') return JSON.stringify({ assetClassRatio: [{ cached: true }] });
        if (key === 'mfcf') return JSON.stringify('mfcf.202401');
        return null;
      });

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token-value' } });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });





    it('should fallback to folder data when CacheService is unavailable', () => {
      delete global.CacheService;

      Code.doGet({ parameter: {}, headers: { Authorization: 'Bearer token-value' } });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });

    it('should return all CSV data when other parameters are provided', () => {
      const e = { parameter: { unknown: 'value' }, headers: { Authorization: 'Bearer token-value' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });

    it('should not skip auth even when DEBUG is true', () => {
      scriptProperties.DEBUG = 'true';
      Code.doGet({ parameter: {}, headers: {} });

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
      expect(global.DriveApp.getFolderById).not.toHaveBeenCalled();
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

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
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

    it('should reject f=preCacheAll without authentication', () => {
      const e = { parameter: { f: 'preCacheAll' }, headers: {} };
      Code.doGet(e);

      expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(
        JSON.stringify({ status: 401, error: 'missing id token' }),
      );
    });

    it('should handle f=preCacheAll when authenticated', () => {
      const e = { parameter: { f: 'preCacheAll' }, headers: { Authorization: 'Bearer token-value' } };
      Code.doGet(e);

      expect(global.UrlFetchApp.fetch).toHaveBeenCalled();
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

  describe('share sessions', () => {
    let shareFileContent;
    let shareFileExists;
    let mockShareFile;
    let mockDataFolder;
    let uuidCounter = 0;

    const shareHashOf = (token) =>
      Array.from({ length: 32 }, (_, i) => token.charCodeAt(i % token.length) % 128)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const lastJson = () => JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);

    const issueToken = () => {
      Code.doGet({
        parameter: { action: 'issue_share' },
        headers: { Authorization: 'Bearer owner-token' },
      });
      return lastJson().share_token;
    };

    const createMockFiles = (filesArray) => {
      let index = 0;
      return {
        hasNext: vi.fn(() => index < filesArray.length),
        next: vi.fn(() => filesArray[index++]),
      };
    };

    const shareRecords = () => JSON.parse(shareFileContent);

    const seedShareFile = (records) => {
      shareFileExists = true;
      shareFileContent = JSON.stringify(records);
    };

    beforeEach(() => {
      scriptProperties.DEBUG = 'false';
      uuidCounter = 0;
      shareFileContent = null;
      shareFileExists = false;

      mockShareFile = {
        getName: vi.fn(() => 'asset-share-sessions.json'),
        getMimeType: vi.fn(() => 'application/json'),
        getBlob: vi.fn(() => ({ getDataAsString: vi.fn(() => shareFileContent) })),
        setContent: vi.fn((content) => { shareFileContent = content; }),
      };

      const csvFiles = [
        {
          getName: () => 'assetClassRatio.csv',
          getBlob: () => ({ getDataAsString: () => 'timestamp,y,other\n2023-01-01,20,val' }),
        },
      ];
      mockDataFolder = {
        getFiles: vi.fn(() => createMockFiles([...csvFiles])),
        getFilesByName: vi.fn((name) =>
          createMockFiles(name === 'asset-share-sessions.json' && shareFileExists ? [mockShareFile] : [])),
        createFile: vi.fn((name, content) => {
          shareFileExists = true;
          shareFileContent = content;
          return mockShareFile;
        }),
      };
      global.DriveApp.getFolderById.mockReturnValue(mockDataFolder);

      global.Utilities = {
        ...global.Utilities,
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        computeDigest: vi.fn((algo, str) =>
          Array.from({ length: 32 }, (_, i) => String(str).charCodeAt(i % String(str).length) % 128)),
        getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
      };
    });

    it('requires an ID token to issue a share session', () => {
      Code.doGet({ parameter: { action: 'issue_share' }, headers: {} });
      expect(lastJson()).toEqual({ status: 401, error: 'missing id token' });
    });

    it('requires an ID token to revoke share sessions', () => {
      Code.doGet({ parameter: { action: 'revoke_share' }, headers: {} });
      expect(lastJson()).toEqual({ status: 401, error: 'missing id token' });
    });

    it('issues a 30-day share session and stores only its hash', () => {
      const before = Date.now();
      const token = issueToken();
      const result = lastJson();
      expect(result.ttl_seconds).toBe(30 * 24 * 60 * 60);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(result.expires_at) - before).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
      expect(Date.parse(result.expires_at) - before).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000 + 5000);
      const records = shareRecords();
      expect(records).toHaveLength(1);
      expect(records[0].token_hash).toBe(shareHashOf(token));
      expect(records[0].token_hash).not.toBe(token);
      expect(shareFileContent).not.toContain(token);
      expect(records[0].access_count).toBe(0);
      expect(records[0].revoked_at).toBe('');
    });

    it('creates the share file in the data folder when it does not exist yet', () => {
      issueToken();
      expect(mockDataFolder.createFile).toHaveBeenCalledWith(
        'asset-share-sessions.json',
        expect.any(String),
        'application/json',
      );
      expect(shareRecords()).toHaveLength(1);
    });

    it('reuses the existing share file instead of creating a new one', () => {
      seedShareFile([]);
      issueToken();
      expect(mockDataFolder.createFile).not.toHaveBeenCalled();
      expect(mockShareFile.setContent).toHaveBeenCalled();
      expect(shareRecords()).toHaveLength(1);
    });

    it('treats a corrupt share file as having no sessions', () => {
      shareFileExists = true;
      shareFileContent = 'not json';
      const token = issueToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(shareRecords()).toHaveLength(1);
      expect(shareRecords()[0].token_hash).toBe(shareHashOf(token));
    });

    it('revokes the previous session when a new one is issued', () => {
      const first = issueToken();
      const second = issueToken();
      expect(first).not.toBe(second);
      const records = shareRecords();
      expect(records).toHaveLength(2);
      expect(records[0].revoked_at).not.toBe('');
      expect(records[1].revoked_at).toBe('');
      Code.doGet({ parameter: { share_token: first } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('serves data with a valid share token and counts the access', () => {
      const token = issueToken();
      Code.doGet({ parameter: { share_token: token } });
      const data = lastJson();
      expect(data.assetClassRatio).toEqual([{ other: 'val', amount_yen: '20' }]);
      const records = shareRecords();
      expect(data._share.expires_at).toBe(records[0].expires_at);
      expect(records[0].access_count).toBe(1);
      expect(records[0].last_accessed_at).not.toBe('');
    });

    it('adds the share flag to cached data as well', () => {
      const token = issueToken();
      const cache = global.CacheService.getScriptCache();
      cache.get.mockImplementation((key) => {
        if (key === '0') return JSON.stringify({ assetClassRatio: [{ cached: true }] });
        if (key === 'mfcf') return JSON.stringify([]);
        return null;
      });
      Code.doGet({ parameter: { share_token: token } });
      const data = lastJson();
      expect(data.no_cache).toBe(false);
      expect(data._share.expires_at).toBe(shareRecords()[0].expires_at);
    });

    it('rejects an expired share token', () => {
      const token = 'expired-token';
      seedShareFile([
        {
          token_hash: shareHashOf(token),
          issued_at: new Date(Date.now() - 3600_000).toISOString(),
          expires_at: new Date(Date.now() - 1800_000).toISOString(),
          revoked_at: '',
          access_count: 0,
          last_accessed_at: '',
        },
      ]);
      Code.doGet({ parameter: { share_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('rejects a revoked share token', () => {
      const token = 'revoked-token';
      seedShareFile([
        {
          token_hash: shareHashOf(token),
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 1800_000).toISOString(),
          revoked_at: new Date().toISOString(),
          access_count: 0,
          last_accessed_at: '',
        },
      ]);
      Code.doGet({ parameter: { share_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('rejects an unknown share token', () => {
      Code.doGet({ parameter: { share_token: 'no-such-token' } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('revokes the active session via the revoke action', () => {
      const token = issueToken();
      Code.doGet({
        parameter: { action: 'revoke_share' },
        headers: { Authorization: 'Bearer owner-token' },
      });
      expect(lastJson()).toEqual({ revoked: true });
      expect(shareRecords()[0].revoked_at).not.toBe('');
      Code.doGet({ parameter: { share_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });
  });

  describe('owner sessions', () => {
    let filesByName;
    let uuidCounter = 0;

    const hashOf = (token) =>
      Array.from({ length: 32 }, (_, i) => token.charCodeAt(i % token.length) % 128)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const lastJson = () => JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);

    const createMockFiles = (filesArray) => {
      let index = 0;
      return {
        hasNext: vi.fn(() => index < filesArray.length),
        next: vi.fn(() => filesArray[index++]),
      };
    };

    const makeFile = (name) => ({
      getName: vi.fn(() => name),
      getMimeType: vi.fn(() => 'application/json'),
      getBlob: vi.fn(() => ({ getDataAsString: vi.fn(() => filesByName[name]) })),
      setContent: vi.fn((content) => { filesByName[name] = content; }),
    });

    const exchange = () => {
      Code.doGet({
        parameter: { action: 'exchange_session' },
        headers: { Authorization: 'Bearer owner-token' },
      });
      return lastJson().session_token;
    };

    const ownerRecords = () => JSON.parse(filesByName['asset-owner-sessions.json']);

    beforeEach(() => {
      scriptProperties.DEBUG = 'false';
      uuidCounter = 0;
      filesByName = {};

      const csvFiles = [
        {
          getName: () => 'assetClassRatio.csv',
          getBlob: () => ({ getDataAsString: () => 'timestamp,y,other\n2023-01-01,20,val' }),
        },
      ];
      const mockFolder = {
        getFiles: vi.fn(() => createMockFiles([...csvFiles])),
        getFilesByName: vi.fn((name) =>
          createMockFiles(filesByName[name] != null ? [makeFile(name)] : [])),
        createFile: vi.fn((name, content) => {
          filesByName[name] = content;
          return makeFile(name);
        }),
      };
      global.DriveApp.getFolderById.mockReturnValue(mockFolder);

      global.Utilities = {
        ...global.Utilities,
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        computeDigest: vi.fn((algo, str) =>
          Array.from({ length: 32 }, (_, i) => String(str).charCodeAt(i % String(str).length) % 128)),
        getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
      };
    });

    it('requires an ID token to exchange for an owner session', () => {
      Code.doGet({ parameter: { action: 'exchange_session' }, headers: {} });
      expect(lastJson()).toEqual({ status: 401, error: 'missing id token' });
    });

    it('issues a 30-day owner session and stores only its hash', () => {
      const token = exchange();
      expect(lastJson().ttl_seconds).toBe(30 * 24 * 60 * 60);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const records = ownerRecords();
      expect(records).toHaveLength(1);
      expect(records[0].token_hash).toBe(hashOf(token));
      expect(filesByName['asset-owner-sessions.json']).not.toContain(token);
    });

    it('serves data with a valid owner session token', () => {
      const token = exchange();
      Code.doGet({ parameter: { session_token: token } });
      const data = lastJson();
      expect(data.assetClassRatio).toEqual([{ other: 'val', amount_yen: '20' }]);
      expect(ownerRecords()[0].access_count).toBe(1);
    });

    it('rejects an unknown owner session token', () => {
      Code.doGet({ parameter: { session_token: 'no-such-token' } });
      expect(lastJson()).toEqual({ status: 401, error: 'session expired or invalid' });
    });

    it('keeps the previous owner session valid when a new one is exchanged', () => {
      const first = exchange();
      const second = exchange();
      expect(first).not.toBe(second);
      const records = ownerRecords();
      expect(records).toHaveLength(2);
      expect(records[0].revoked_at).toBe('');
      expect(records[1].revoked_at).toBe('');
      Code.doGet({ parameter: { session_token: first } });
      expect(lastJson().assetClassRatio).toEqual([{ other: 'val', amount_yen: '20' }]);
      Code.doGet({ parameter: { session_token: second } });
      expect(lastJson().assetClassRatio).toEqual([{ other: 'val', amount_yen: '20' }]);
    });

    it('revokes the owner session via the revoke_session action', () => {
      const token = exchange();
      Code.doGet({ parameter: { action: 'revoke_session', session_token: token } });
      expect(lastJson()).toEqual({ revoked: true });
      Code.doGet({ parameter: { session_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'session expired or invalid' });
    });

    it('accepts an owner session as proof for issuing a share link', () => {
      const token = exchange();
      Code.doGet({ parameter: { action: 'issue_share', session_token: token } });
      expect(lastJson().share_token).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('data folder override (staging)', () => {
    it('uses the production folder when DATA_FOLDER_ID is unset', () => {
      Code.getAllXmlDataEntries_();
      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith(
        '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh'
      );
    });

    it('uses DATA_FOLDER_ID when the script property is set', () => {
      scriptProperties.DATA_FOLDER_ID = 'staging-folder-id';
      Code.getAllXmlDataEntries_();
      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('staging-folder-id');
    });
  });

  describe('dashboard RSS', () => {
    const monthKeyOf = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const shiftMonthKey = (monthKey, delta) => {
      const [year, month] = monthKey.split('-').map(Number);
      return monthKeyOf(new Date(year, month - 1 + delta, 1));
    };
    const nowDate = new Date();
    const currentMonth = monthKeyOf(nowDate);
    const lastMonth = shiftMonthKey(currentMonth, -1);
    const todayKey = `${currentMonth}-${String(nowDate.getDate()).padStart(2, '0')}`;

    const buildFixturePortfolio = () => {
      const cashFlow = [];
      for (let i = 1; i <= 12; i++) {
        cashFlow.push({
          date: `${shiftMonthKey(currentMonth, -i)}-05`,
          amount: -100000,
          name: 'スーパー',
          category: '食費/食料品',
          isTransfer: false,
        });
      }
      // Last month: a clothing/beauty spike (its 12-month
      // average is near zero, so it must be flagged), the full
      // investment standard, and a recent expense.
      cashFlow.push(
        { date: `${lastMonth}-10`, amount: -30000, name: '美容院', category: '衣服・美容/美容院・理髪', isTransfer: false },
        { date: `${lastMonth}-11`, amount: -20000, name: '化粧品', category: '衣服・美容/その他', isTransfer: false },
        { date: `${lastMonth}-26`, amount: -23000, name: 'コクミンネンキンキキンレンゴウカイ(カクテイキヨシユツネンキン)', category: '', isTransfer: true },
        { date: `${lastMonth}-24`, amount: -300000, name: 'ラクテンショウケンカブシキガイシャ (投信積立代金)', category: '', isTransfer: true },
        { date: todayKey, amount: -1500, name: 'コンビニ', category: '食費/食料品', isTransfer: false },
      );
      return {
        totals: { assetsYen: 6500000, liabilitiesYen: 1000000, netWorthYen: 5500000 },
        summary: { assetsByClass: [], liabilitiesByCategory: [] },
        holdings: {
          cashLike: [{ '名称': '銀行預金', '残高': '1000000' }],
          stocks: [{ '銘柄名': 'テスト株', '評価額': '2000000', '前日比': '-20000' }],
          funds: [{ '銘柄名': 'テスト投信', '評価額': '3000000', '前日比': '15000' }],
          pensions: [{ '名称': '確定拠出年金', '現在価値': '500000', '評価損益率': '10' }],
          points: [],
          liabilitiesDetail: [],
        },
        cashFlow,
        snapshots: [
          {
            month: shiftMonthKey(currentMonth, -2),
            totalAssetsYen: 6000000,
            totalLiabilitiesYen: 1000000,
            netAssetsYen: 5000000,
            cashYen: 1000000,
            riskAssetsYen: 5000000,
            livingCost12mAvgYen: 100000,
            income12mAvgYen: 300000,
          },
          {
            month: lastMonth,
            totalAssetsYen: 6500000,
            totalLiabilitiesYen: 1000000,
            netAssetsYen: 5500000,
            cashYen: 1000000,
            riskAssetsYen: 5500000,
            livingCost12mAvgYen: 100000,
            income12mAvgYen: 300000,
          },
        ],
      };
    };

    it('picks today\'s slot at or after 06:20 JST and yesterday\'s before it', () => {
      expect(Code.dashboardRssSlot_(Date.parse('2026-11-17T06:20:00+09:00')).dateKey).toBe('2026-11-17');
      expect(Code.dashboardRssSlot_(Date.parse('2026-11-17T06:19:59+09:00')).dateKey).toBe('2026-11-16');
      expect(Code.dashboardRssSlot_(Date.parse('2026-11-17T23:59:00+09:00')).dateKey).toBe('2026-11-17');
    });

    it('normalizes the raw API payload like the front end', () => {
      const portfolio = Code.dashboardNormalizePortfolio_({
        breakdown: [{ category: '預金・現金', amount_yen: '1000000', percentage: '20' }],
        'total-liability': [{ total_yen: '500000' }],
        mfcf: [
          { date: '2026-11-01', amount: -1000, currency: 'JPY', name: 'A', category: '食費/食料品', is_transfer: false },
          { date: '2026-11-01', amount: -1000, currency: 'JPY', name: 'A', category: '食費/食料品', is_transfer: false },
        ],
        snapshots: [
          { month: '2026-10', total_assets: '6000000', total_liabilities: '500000', net_assets: '5500000', cash: '1000000', risk_assets: '5000000', living_cost_12m_avg: '100000', income_12m_avg: '300000' },
        ],
      });
      expect(portfolio.totals).toEqual({ assetsYen: 1000000, liabilitiesYen: 500000, netWorthYen: 500000 });
      // The duplicate mfcf row is dropped, as on the front end.
      expect(portfolio.cashFlow).toHaveLength(1);
      expect(portfolio.snapshots[0].netAssetsYen).toBe(5500000);
    });

    it('builds an item carrying all five home blocks with the screen values', () => {
      const item = Code.buildDashboardRssItem_(buildFixturePortfolio(), Date.now());
      expect(item.title).toMatch(/^\d+月\d+日 資産ダッシュボード$/);
      expect(item.guid).toMatch(/^asset-dashboard-\d{4}-\d{2}-\d{2}$/);

      const text = item.descriptionText;
      expect(text).toContain('【今月の結論】');
      expect(text).toContain('純資産は ¥5,500,000');
      expect(text).toContain('先月比 +¥500,000');
      expect(text).toContain('【資産推移】');
      expect(text).toContain('リスク資産は前日比 -¥5,000');
      expect(text).toContain('テスト株');
      expect(text).toContain('【要確認】');
      expect(text).toContain('衣服・美容が12か月平均を大きく上回りました');
      expect(text).toContain('美容院');
      expect(text).toContain('生活費が12か月平均の+10%を超えました');
      expect(text).toContain('【過去3日間の支出】');
      expect(text).toContain('コンビニ');
      expect(text).toContain('【FIRE進捗の要点（完全FIRE）】');
      expect(text).toContain('到達率');
      expect(text).toContain('詳しくは https://freddiefujiwara.com/asset/');
    });

    it('includes the two 100M asset goals in the FIRE section', () => {
      const item = Code.buildDashboardRssItem_(buildFixturePortfolio(), Date.now());
      const text = item.descriptionText;
      expect(text).toContain('金融資産1億円：達成度 6.5%');
      expect(text).toContain('純金融資産1億円：達成度 5.5%');
    });

    it('projects liabilities with the principal-only mortgage approximation', () => {
      const base = {
        currentLiabilitiesYen: 11510887,
        mortgageMonthlyPayment: 61089,
        mortgagePayoffDate: '2042-05',
        startMonthKey: '2026-11',
        monthOffset: 0,
      };
      expect(Code.dashboardProjectLiabilitiesYen_(base)).toBe(11510887);
      expect(Code.dashboardProjectLiabilitiesYen_({ ...base, monthOffset: 10 })).toBe(11510887 - 610890);
      expect(Code.dashboardProjectLiabilitiesYen_({ ...base, monthOffset: 500 })).toBe(87244);
      expect(Code.dashboardProjectLiabilitiesYen_({ ...base, mortgageMonthlyPayment: 0 })).toBe(11510887);
      expect(Code.dashboardProjectLiabilitiesYen_({ ...base, mortgagePayoffDate: null })).toBe(11510887);
    });

    it('matches the front end\u2019s asset-goal projection on the same fixture', () => {
      // Same fixture and base params as the front end's
      // domain/progress tests; the summaries must be identical.
      const portfolio = {
        totals: { assetsYen: 78139712, liabilitiesYen: 11510887, netWorthYen: 66628825 },
        holdings: {
          cashLike: [{ '名称': '銀行預金', '残高': 7502164 }],
          stocks: [{ '名称': '株式A', '評価額': 17538769 }],
          funds: [{ '名称': '投信A', '評価額': 49569663 }],
          pensions: [{ '名称': '確定拠出年金', '現在価値': 3457712 }],
          points: [],
          liabilitiesDetail: [],
        },
      };
      const baseParams = {
        annualReturnRate: 0.05,
        monthlyExpense: 483688,
        monthlyIncome: 1071000,
        currentAge: 47,
        includeInflation: true,
        inflationRate: 0.02,
        includeTax: true,
        taxRate: 0.20315,
        withdrawalRate: 0.04,
        mortgageMonthlyPayment: 61089,
        mortgagePayoffDate: '2042-05',
        postFireExtraExpense: 60000,
        postFireFirstYearExtraExpense: 1930000,
        retirementLumpSumAtFire: 5000000,
        includePension: true,
        monthlyInvestment: 423000,
        expenseBreakdown: null,
      };
      const goals = Code.dashboardBuildAssetGoals_({ portfolio, baseParams, startMonthKey: '2026-11' });
      expect(goals.total).toEqual({
        reached: true,
        alreadyReached: false,
        monthsToReach: 25,
        projectedMonth: '2028-12',
        progressRate: 0.78139712,
      });
      expect(goals.net).toEqual({
        reached: true,
        alreadyReached: false,
        monthsToReach: 35,
        projectedMonth: '2029-10',
        progressRate: 0.66628825,
      });
      expect(goals.series[0]).toEqual({
        monthOffset: 0,
        monthKey: '2026-11',
        totalAssetsYen: 78139712,
        liabilitiesYen: 11510887,
        netAssetsYen: 66628825,
      });
    });

    it('renders the item as RSS 2.0 with a stable guid and pubDate', () => {
      const item = Code.buildDashboardRssItem_(buildFixturePortfolio(), Date.now());
      const xml = Code.buildDashboardRss_([item]);
      expect(xml).toContain('<rss version="2.0">');
      expect(xml).toContain('<title>資産ダッシュボード</title>');
      expect(xml).toContain(`<guid isPermaLink="false">${item.guid}</guid>`);
      expect(xml).toContain(`<pubDate>${item.pubDate}</pubDate>`);
      // 06:20 JST is 21:20 UTC of the previous day.
      expect(item.pubDate).toContain('21:20:00 GMT');
    });

    it('refuses the feed while the token property is unset', () => {
      Code.doGet({ parameter: { action: 'dashboard_rss', token: 'anything' } });
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ ok: false, status: 403, error: 'invalid token' });
    });

    it('refuses the feed when the token mismatches', () => {
      scriptProperties.DASHBOARD_RSS_TOKEN = 'expected-token';
      Code.doGet({ parameter: { action: 'dashboard_rss', token: 'wrong-token' } });
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ ok: false, status: 403, error: 'invalid token' });
    });

    it('serves RSS XML when the token matches', () => {
      scriptProperties.DASHBOARD_RSS_TOKEN = 'expected-token';
      Code.doGet({ parameter: { action: 'dashboard_rss', token: 'expected-token' } });
      const xml = global.ContentService.createTextOutput.mock.calls.at(-1)[0];
      expect(xml).toContain('<rss version="2.0">');
      expect(xml).toContain('資産ダッシュボード');
    });
  });

  describe('warm_cache endpoint', () => {
    it('refuses while the token property is unset', () => {
      Code.doGet({ parameter: { action: 'warm_cache', token: 'anything' } });
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ ok: false, status: 403, error: 'invalid token' });
      expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
    });

    it('refuses when the token is missing', () => {
      scriptProperties.WARM_CACHE_TOKEN = 'expected-token';
      Code.doGet({ parameter: { action: 'warm_cache' } });
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ ok: false, status: 403, error: 'invalid token' });
      expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
    });

    it('refuses when the token mismatches', () => {
      scriptProperties.WARM_CACHE_TOKEN = 'expected-token';
      Code.doGet({ parameter: { action: 'warm_cache', token: 'wrong-token' } });
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ ok: false, status: 403, error: 'invalid token' });
      expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
    });

    it('runs preCacheAll and returns its result when the token matches', () => {
      scriptProperties.WARM_CACHE_TOKEN = 'expected-token';
      Code.doGet({ parameter: { action: 'warm_cache', token: 'expected-token' } });
      expect(global.CacheService.getScriptCache).toHaveBeenCalled();
      const payload = JSON.parse(global.ContentService.createTextOutput.mock.calls.at(-1)[0]);
      expect(payload).toEqual({ status: true, cachedKeys: ['0', 'mfcf'] });
    });
  });

  describe('self-service cache warming', () => {
    // 2026-11-19 12:00 JST, and the newest file update one
    // hour before it (11:00 JST): settled, and "today" in
    // JST even though UTC is still on the same morning.
    const NOW_MS = Date.UTC(2026, 10, 19, 3, 0, 0);
    const LATEST_MS = Date.UTC(2026, 10, 19, 2, 0, 0);
    const BATCH_KEY = `2026-11-19:${LATEST_MS}`;
    const settledBatch = () =>
      Array.from({ length: 13 }, (_, i) => LATEST_MS - i * 60 * 1000);

    describe('expectedMfcfMonthKeys_', () => {
      it('returns the current month plus the previous twelve, newest first', () => {
        expect(Code.expectedMfcfMonthKeys_(new Date(2026, 10, 19))).toEqual([
          '202611', '202610', '202609', '202608', '202607', '202606', '202605',
          '202604', '202603', '202602', '202601', '202512', '202511',
        ]);
      });

      it('crosses the year boundary', () => {
        const keys = Code.expectedMfcfMonthKeys_(new Date(2027, 0, 15));
        expect(keys[0]).toBe('202701');
        expect(keys[1]).toBe('202612');
        expect(keys[12]).toBe('202601');
      });
    });

    describe('decideCacheWarm_', () => {
      it('warms when all 13 files were updated today (JST) and the batch settled', () => {
        expect(Code.decideCacheWarm_(settledBatch(), NOW_MS, '')).toEqual({
          shouldWarm: true,
          batchKey: BATCH_KEY,
        });
      });

      it('counts an update just after JST midnight as today, not as yesterday UTC', () => {
        const times = settledBatch();
        // 00:30 JST on Nov 19 is still Nov 18 in UTC.
        times[12] = Date.UTC(2026, 10, 18, 15, 30, 0);
        expect(Code.decideCacheWarm_(times, NOW_MS, '').shouldWarm).toBe(true);
      });

      it('does not warm while a file is missing', () => {
        expect(Code.decideCacheWarm_(settledBatch().slice(1), NOW_MS, '')).toEqual({
          shouldWarm: false,
          batchKey: '',
        });
      });

      it('does not warm when one file is still on yesterday (JST)', () => {
        const times = settledBatch();
        // 23:59 JST on Nov 18.
        times[12] = Date.UTC(2026, 10, 18, 14, 59, 0);
        const decision = Code.decideCacheWarm_(times, NOW_MS, '');
        expect(decision.shouldWarm).toBe(false);
        expect(decision.batchKey).toBe(BATCH_KEY);
      });

      it('does not warm until the newest update is five minutes old', () => {
        const times = settledBatch();
        times[0] = NOW_MS - 4 * 60 * 1000;
        expect(Code.decideCacheWarm_(times, NOW_MS, '').shouldWarm).toBe(false);
        times[0] = NOW_MS - 5 * 60 * 1000;
        expect(Code.decideCacheWarm_(times, NOW_MS, '').shouldWarm).toBe(true);
      });

      it('does not warm the same batch twice', () => {
        expect(Code.decideCacheWarm_(settledBatch(), NOW_MS, BATCH_KEY).shouldWarm).toBe(false);
      });

      it('warms again when a re-export moves the newest timestamp', () => {
        const times = settledBatch().map((t) => t + 30 * 60 * 1000);
        const decision = Code.decideCacheWarm_(times, NOW_MS, BATCH_KEY);
        expect(decision.shouldWarm).toBe(true);
        expect(decision.batchKey).toBe(`2026-11-19:${LATEST_MS + 30 * 60 * 1000}`);
      });

      it('rejects malformed input without warming', () => {
        expect(Code.decideCacheWarm_(null, NOW_MS, '')).toEqual({ shouldWarm: false, batchKey: '' });
        const times = settledBatch();
        times[3] = Number.NaN;
        expect(Code.decideCacheWarm_(times, NOW_MS, '').shouldWarm).toBe(false);
      });
    });

    describe('warmCacheWhenDataReady', () => {
      let propertyStore;

      const iteratorOf = (files) => {
        let index = 0;
        return {
          hasNext: () => index < files.length,
          next: () => files[index++],
        };
      };

      const mfcfFile = (yyyymm, updatedMs) => ({
        getName: () => `mfcf.${yyyymm}.xml`,
        getLastUpdated: () => new Date(updatedMs),
        getBlob: () => ({ getDataAsString: () => '' }),
      });

      // File names are derived from the (fake) clock the same
      // way the entry point derives them, so the test does not
      // depend on the machine time zone.
      const monthKeysFrom = (ms) => {
        const base = new Date(ms);
        return Array.from({ length: 13 }, (_, i) => {
          const month = new Date(base.getFullYear(), base.getMonth() - i, 1);
          return `${month.getFullYear()}${String(month.getMonth() + 1).padStart(2, '0')}`;
        });
      };

      beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        propertyStore = { DEBUG: 'true', NO_CACHE: 'false' };
        global.PropertiesService = {
          getScriptProperties: vi.fn(() => ({
            getProperty: vi.fn((key) => propertyStore[key] ?? ''),
            setProperty: vi.fn((key, value) => {
              propertyStore[key] = String(value);
            }),
          })),
        };
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      const mockDataFolder = (files) => {
        global.DriveApp = {
          getFolderById: vi.fn(() => ({
            getFilesByName: vi.fn((name) => iteratorOf(files.filter((f) => f.getName() === name))),
            getFiles: vi.fn(() => iteratorOf(files)),
          })),
        };
      };

      const settledFiles = () =>
        monthKeysFrom(NOW_MS).map((yyyymm, i) => mfcfFile(yyyymm, LATEST_MS - i * 60 * 1000));

      it('warms the cache and records the batch once the files are ready', () => {
        mockDataFolder(settledFiles());
        const result = Code.warmCacheWhenDataReady();
        expect(result).toEqual({ warmed: true, batchKey: BATCH_KEY });
        expect(global.CacheService.getScriptCache).toHaveBeenCalled();
        expect(propertyStore.WARMED_BATCH_KEY).toBe(BATCH_KEY);
      });

      it('stays a no-op on the next poll of the same batch', () => {
        mockDataFolder(settledFiles());
        Code.warmCacheWhenDataReady();
        vi.clearAllMocks();
        const result = Code.warmCacheWhenDataReady();
        expect(result).toEqual({ warmed: false, batchKey: BATCH_KEY });
        expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
      });

      it('does nothing while one monthly file is still missing', () => {
        mockDataFolder(settledFiles().slice(1));
        const result = Code.warmCacheWhenDataReady();
        expect(result.warmed).toBe(false);
        expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
        expect(propertyStore.WARMED_BATCH_KEY).toBeUndefined();
      });

      it('does nothing while the write burst has not settled yet', () => {
        const files = settledFiles();
        files[0] = mfcfFile(files[0].getName().slice(5, 11), NOW_MS - 60 * 1000);
        mockDataFolder(files);
        const result = Code.warmCacheWhenDataReady();
        expect(result.warmed).toBe(false);
        expect(global.CacheService.getScriptCache).not.toHaveBeenCalled();
      });

      it('warms again when a midday re-export forms a new batch', () => {
        mockDataFolder(settledFiles());
        Code.warmCacheWhenDataReady();
        const refreshed = monthKeysFrom(NOW_MS).map((yyyymm, i) =>
          mfcfFile(yyyymm, LATEST_MS + 30 * 60 * 1000 - i * 60 * 1000));
        mockDataFolder(refreshed);
        vi.clearAllMocks();
        const result = Code.warmCacheWhenDataReady();
        expect(result.warmed).toBe(true);
        expect(propertyStore.WARMED_BATCH_KEY).toBe(`2026-11-19:${LATEST_MS + 30 * 60 * 1000}`);
      });
    });

    describe('installCacheWarmTrigger', () => {
      it('replaces existing triggers for the same handler and installs a 15-minute one', () => {
        const deleted = [];
        const existing = [
          { getHandlerFunction: () => 'warmCacheWhenDataReady', id: 'old-1' },
          { getHandlerFunction: () => 'otherHandler', id: 'old-2' },
        ];
        const builder = {
          timeBased: vi.fn().mockReturnThis(),
          everyMinutes: vi.fn().mockReturnThis(),
          create: vi.fn(() => ({ getUniqueId: () => 'new-trigger-id' })),
        };
        global.ScriptApp = {
          getProjectTriggers: vi.fn(() => existing),
          deleteTrigger: vi.fn((trigger) => deleted.push(trigger)),
          newTrigger: vi.fn(() => builder),
        };

        const result = Code.installCacheWarmTrigger();

        expect(deleted).toEqual([existing[0]]);
        expect(global.ScriptApp.newTrigger).toHaveBeenCalledWith('warmCacheWhenDataReady');
        expect(builder.everyMinutes).toHaveBeenCalledWith(15);
        expect(result).toEqual({
          installed: true,
          handler: 'warmCacheWhenDataReady',
          triggerId: 'new-trigger-id',
        });
      });
    });
  });

  describe('region weights', () => {
    const ACWI_URL = 'https://www.msci.com/documents/10199/dad48a28-fafb-4e4a-bfff-8ff7ddf9df90';
    const WORLD_URL = 'https://www.msci.com/documents/10199/255599/msci-world-index-usd-net.pdf';

    // Factsheet-like plain text, as the Drive document
    // conversion of the PDF would produce it. The country
    // weights match the published 2026-10-30 values, so the
    // derived sets must reproduce the seed exactly.
    const factsheetText = ({ us, japan, date = 'OCT 30, 2026', other = '20.88' }) =>
      [
        'MSCI Index Factsheet',
        `INDEX PERFORMANCE — NET RETURNS (%) (${date}) FUNDAMENTALS (${date})`,
        'The index was launched on May 31, 1990. Data prior to the launch date is back-tested.',
        'INDEX CHARACTERISTICS TOP 10 CONSTITUENTS',
        'APPLE US 5.02 Info Tech',
        'SECTOR WEIGHTS COUNTRY WEIGHTS',
        `Information Technology 31.18% Financials 16.63% United States ${us}% Japan ${japan}% Taiwan 3.23% United Kingdom 3.12% Canada 3.06% Other ${other}%`,
        '* DM countries include: Australia, Austria, Belgium, Canada, Denmark, Finland, France, Germany, Hong Kong, Ireland, Israel, Italy, Japan, Netherlands, New Zealand, Norway, Portugal, Singapore, Spain, Sweden, Switzerland, the UK and the US.',
      ].join('\n');
    const ACWI_TEXT = factsheetText({ us: '64.63', japan: '5.08' });
    const WORLD_TEXT = factsheetText({ us: '72.77', japan: '5.72', other: '11.91' });

    // Route UrlFetchApp.fetch through the whole pipeline:
    // factsheet PDF download -> Drive conversion upload ->
    // text export. Returns the trash spy for the temp files.
    const mockFactsheetPipeline = ({ acwiText = ACWI_TEXT, worldText = WORLD_TEXT } = {}) => {
      global.ScriptApp = { getOAuthToken: vi.fn(() => 'test-oauth-token') };
      global.Utilities.newBlob = vi.fn(() => ({ getBytes: () => [37, 80, 68, 70] }));
      const setTrashed = vi.fn();
      global.DriveApp.getFileById = vi.fn(() => ({ setTrashed }));
      const exportedByTempId = new Map();
      let pendingText = acwiText;
      let counter = 0;
      global.UrlFetchApp.fetch = vi.fn((url) => {
        if (url === ACWI_URL || url === WORLD_URL) {
          pendingText = url === ACWI_URL ? acwiText : worldText;
          if (pendingText instanceof Error) {
            throw pendingText;
          }
          return {
            getResponseCode: () => 200,
            getBlob: () => ({ getBytes: () => [37, 80, 68, 70] }),
          };
        }
        if (url.includes('/upload/drive/v3/files')) {
          counter += 1;
          const id = `temp-${counter}`;
          exportedByTempId.set(id, pendingText);
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ id }) };
        }
        if (url.includes('/export')) {
          const id = url.match(/files\/([^/]+)\/export/)[1];
          return { getResponseCode: () => 200, getContentText: () => exportedByTempId.get(id) ?? '' };
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      return { setTrashed };
    };

    const createIterator = (files) => {
      let index = 0;
      return { hasNext: () => index < files.length, next: () => files[index++] };
    };

    const mockWeightsFolder = (initialFiles = []) => {
      const files = [...initialFiles];
      const created = [];
      const folder = {
        getFiles: vi.fn(() => createIterator(files)),
        getFilesByName: vi.fn((name) => createIterator(files.filter((f) => f.getName() === name))),
        createFile: vi.fn((name, content) => {
          created.push({ name, content });
          files.push({
            getName: () => name,
            getBlob: () => ({ getDataAsString: () => content }),
            setContent: vi.fn(),
          });
          return files[files.length - 1];
        }),
      };
      global.DriveApp.getFolderById.mockReturnValue(folder);
      return { folder, files, created };
    };

    describe('parseRegionWeightsRows_', () => {
      it('reshapes rows and fills missing buckets with 0', () => {
        const sets = Code.parseRegionWeightsRows_([
          { weight_set: 'acwi', bucket: 'us', weight: '64.63', effective_date: '2026-10-30' },
          { weight_set: 'acwi', bucket: 'japan', weight: '5.08', effective_date: '2026-10-30' },
        ]);
        expect(sets.acwi.us).toBe(64.63);
        expect(sets.acwi.japan).toBe(5.08);
        expect(sets.acwi.emerging).toBe(0);
        expect(sets.acwi.effective_date).toBe('2026-10-30');
      });

      it('accepts acwi_ex_japan rows', () => {
        const sets = Code.parseRegionWeightsRows_([
          { weight_set: 'acwi_ex_japan', bucket: 'us', weight: '68.09', effective_date: '2026-10-30' },
          { weight_set: 'acwi_ex_japan', bucket: 'emerging', weight: '11.79', effective_date: '2026-10-30' },
        ]);
        expect(sets.acwi_ex_japan.us).toBe(68.09);
        expect(sets.acwi_ex_japan.japan).toBe(0);
        expect(sets.acwi_ex_japan.emerging).toBe(11.79);
        expect(sets.acwi_ex_japan.effective_date).toBe('2026-10-30');
      });

      it('ignores unknown sets, buckets and invalid weights', () => {
        const sets = Code.parseRegionWeightsRows_([
          { weight_set: 'nope', bucket: 'us', weight: '1', effective_date: '2026-10-30' },
          { weight_set: 'acwi', bucket: 'moon', weight: '1', effective_date: '2026-10-30' },
          { weight_set: 'acwi', bucket: 'us', weight: '-3', effective_date: '2026-10-30' },
          { weight_set: 'acwi', bucket: 'us', weight: 'abc', effective_date: '2026-10-30' },
        ]);
        expect(sets).toBeNull();
      });

      it('returns null for non-array input', () => {
        expect(Code.parseRegionWeightsRows_(null)).toBeNull();
        expect(Code.parseRegionWeightsRows_([])).toBeNull();
      });
    });

    describe('buildRegionWeights_', () => {
      it('falls back to the seed when rows are unusable', () => {
        const sets = Code.buildRegionWeights_(null);
        expect(sets.acwi.us).toBe(64.63);
        expect(sets.acwi.effective_date).toBe('2026-10-30');
        expect(sets.acwi_ex_japan).toEqual({
          japan: 0, us: 68.09, developed_other: 20.12, emerging: 11.79, other: 0,
          effective_date: '2026-10-30',
        });
        expect(sets.developed.japan).toBe(0);
        expect(sets.emerging.emerging).toBe(100);
      });

      it('prefers parsed rows over the seed', () => {
        const sets = Code.buildRegionWeights_([
          { weight_set: 'acwi', bucket: 'us', weight: '50', effective_date: '2026-11-02' },
        ]);
        expect(sets.acwi.us).toBe(50);
        expect(sets.acwi.effective_date).toBe('2026-11-02');
      });
    });

    describe('parseMsciFactsheet_', () => {
      it('extracts the as-of date and the US / Japan country weights', () => {
        const facts = Code.parseMsciFactsheet_(ACWI_TEXT);
        expect(facts).toEqual({ asOf: '2026-10-30', us: 64.63, japan: 5.08 });
      });

      it('tolerates casing and line-break variation from the conversion', () => {
        const text = [
          'Index Factsheet',
          'Index Performance (Oct 30, 2026)',
          'Country Weights',
          'United States',
          '64.63 %',
          'Japan 5.08 %',
        ].join('\n');
        expect(Code.parseMsciFactsheet_(text)).toEqual({ asOf: '2026-10-30', us: 64.63, japan: 5.08 });
      });

      it('returns null without a COUNTRY WEIGHTS section', () => {
        expect(Code.parseMsciFactsheet_('United States 64.63% Japan 5.08% OCT 30, 2026')).toBeNull();
      });

      it('returns null when a country weight is missing', () => {
        const text = factsheetText({ us: '64.63', japan: '5.08' }).replace('Japan 5.08%', 'Japan');
        expect(Code.parseMsciFactsheet_(text)).toBeNull();
      });

      it('returns null for non-string input', () => {
        expect(Code.parseMsciFactsheet_(null)).toBeNull();
        expect(Code.parseMsciFactsheet_('')).toBeNull();
      });
    });

    describe('deriveRegionWeightSets_', () => {
      it('reproduces the seed weights from the 2026-10-30 factsheet values', () => {
        const sets = Code.deriveRegionWeightSets_(
          { us: 64.63, japan: 5.08 },
          { us: 72.77, japan: 5.72 },
        );
        expect(sets.acwi).toEqual({ japan: 5.08, us: 64.63, developed_other: 19.1, emerging: 11.19, other: 0 });
        expect(sets.acwi_ex_japan).toEqual({ japan: 0, us: 68.09, developed_other: 20.12, emerging: 11.79, other: 0 });
        expect(sets.developed).toEqual({ japan: 0, us: 77.19, developed_other: 22.81, emerging: 0, other: 0 });
        expect(sets.emerging).toEqual({ japan: 0, us: 0, developed_other: 0, emerging: 100, other: 0 });
      });

      it('returns null when the World Japan weight does not exceed the ACWI one', () => {
        expect(Code.deriveRegionWeightSets_({ us: 64.63, japan: 5.72 }, { us: 72.77, japan: 5.08 })).toBeNull();
        expect(Code.deriveRegionWeightSets_({ us: 64.63, japan: 5.08 }, { us: 72.77, japan: 5.08 })).toBeNull();
      });

      it('returns null when a weight is outside its plausible range', () => {
        expect(Code.deriveRegionWeightSets_({ us: 90, japan: 5.08 }, { us: 72.77, japan: 5.72 })).toBeNull();
        expect(Code.deriveRegionWeightSets_({ us: 64.63, japan: 1.5 }, { us: 72.77, japan: 5.72 })).toBeNull();
      });

      it('returns null when the implied emerging share is implausible', () => {
        // Developed share 3.5 / 5.5 = 63.6% -> emerging 36.4%.
        expect(Code.deriveRegionWeightSets_({ us: 55, japan: 3.5 }, { us: 60, japan: 5.5 })).toBeNull();
      });

      it('returns null for missing input', () => {
        expect(Code.deriveRegionWeightSets_(null, { us: 72.77, japan: 5.72 })).toBeNull();
        expect(Code.deriveRegionWeightSets_({ us: 64.63, japan: 5.08 }, null)).toBeNull();
      });
    });

    describe('convertPdfBlobToText_', () => {
      it('returns the exported text and trashes the temporary file', () => {
        const { setTrashed } = mockFactsheetPipeline();
        const text = Code.convertPdfBlobToText_({ getBytes: () => [37, 80, 68, 70] });
        expect(text).toBe(ACWI_TEXT);
        expect(setTrashed).toHaveBeenCalledWith(true);
      });

      it('returns null and creates nothing to trash when the upload fails', () => {
        const { setTrashed } = mockFactsheetPipeline();
        const pipeline = global.UrlFetchApp.fetch;
        global.UrlFetchApp.fetch = vi.fn((url, ...rest) =>
          url.includes('/upload/drive/v3/files')
            ? { getResponseCode: () => 500, getContentText: () => '' }
            : pipeline(url, ...rest));
        expect(Code.convertPdfBlobToText_({ getBytes: () => [] })).toBeNull();
        expect(setTrashed).not.toHaveBeenCalled();
      });
    });

    describe('updateRegionWeights', () => {
      it('rewrites region-weights.csv with the factsheet date and derived weights', () => {
        mockFactsheetPipeline();
        const { created } = mockWeightsFolder();
        const result = Code.updateRegionWeights();
        expect(result.updated).toBe(true);
        expect(result.effectiveDate).toBe('2026-10-30');
        expect(created).toHaveLength(1);
        expect(created[0].name).toBe('region-weights.csv');
        expect(created[0].content).toContain('acwi,us,64.63,2026-10-30');
        expect(created[0].content).toContain('acwi,japan,5.08,2026-10-30');
        expect(created[0].content).toContain('acwi,emerging,11.19,2026-10-30');
        expect(created[0].content).toContain('acwi_ex_japan,japan,0,2026-10-30');
        expect(created[0].content).toContain('acwi_ex_japan,us,68.09,2026-10-30');
        expect(created[0].content).toContain('acwi_ex_japan,emerging,11.79,2026-10-30');
        expect(created[0].content).toContain('developed,us,77.19,2026-10-30');
      });

      it('keeps the current CSV when a factsheet cannot be fetched', () => {
        mockFactsheetPipeline({ acwiText: new Error('network down') });
        const { created } = mockWeightsFolder();
        const result = Code.updateRegionWeights();
        expect(result.updated).toBe(false);
        expect(created).toHaveLength(0);
      });

      it('keeps the current CSV when the conversion upload fails', () => {
        mockFactsheetPipeline();
        const pipeline = global.UrlFetchApp.fetch;
        global.UrlFetchApp.fetch = vi.fn((url, ...rest) =>
          url.includes('/upload/drive/v3/files')
            ? { getResponseCode: () => 403, getContentText: () => '' }
            : pipeline(url, ...rest));
        const { created } = mockWeightsFolder();
        expect(Code.updateRegionWeights().updated).toBe(false);
        expect(created).toHaveLength(0);
      });

      it('keeps the current CSV when the factsheet text does not parse', () => {
        mockFactsheetPipeline({ acwiText: 'some unrelated document', worldText: 'another one' });
        const { created } = mockWeightsFolder();
        expect(Code.updateRegionWeights().updated).toBe(false);
        expect(created).toHaveLength(0);
      });

      it('keeps the current CSV when the two factsheets disagree on the date', () => {
        mockFactsheetPipeline({
          worldText: factsheetText({ us: '72.77', japan: '5.72', date: 'NOV 28, 2026', other: '11.91' }),
        });
        const { created } = mockWeightsFolder();
        const result = Code.updateRegionWeights();
        expect(result.updated).toBe(false);
        expect(result.reason).toContain('dates differ');
        expect(created).toHaveLength(0);
      });

      it('keeps the current CSV when the derived weights fail validation', () => {
        mockFactsheetPipeline({
          worldText: factsheetText({ us: '72.77', japan: '5.08', other: '11.91' }),
        });
        const { created } = mockWeightsFolder();
        expect(Code.updateRegionWeights().updated).toBe(false);
        expect(created).toHaveLength(0);
      });

      it('keeps the current CSV when the factsheet is older than the weights on file', () => {
        mockFactsheetPipeline();
        const existingContent = [
          'weight_set,bucket,weight,effective_date',
          'acwi,japan,5.08,2026-11-30',
          'acwi,us,64.63,2026-11-30',
        ].join('\n');
        const existing = {
          getName: () => 'region-weights.csv',
          getBlob: () => ({ getDataAsString: () => existingContent }),
          setContent: vi.fn(),
        };
        const { created } = mockWeightsFolder([existing]);
        const result = Code.updateRegionWeights();
        expect(result.updated).toBe(false);
        expect(result.reason).toContain('older than current');
        expect(existing.setContent).not.toHaveBeenCalled();
        expect(created).toHaveLength(0);
      });
    });

    describe('ensureRegionWeightsFile', () => {
      it('creates the CSV from the seed when missing', () => {
        const { created } = mockWeightsFolder();
        const result = Code.ensureRegionWeightsFile();
        expect(result.created).toBe(true);
        expect(created[0].content).toContain('acwi,us,64.63,2026-10-30');
        expect(created[0].content).toContain('acwi_ex_japan,us,68.09,2026-10-30');
        expect(created[0].content).toContain('acwi_ex_japan,developed_other,20.12,2026-10-30');
        expect(created[0].content).toContain('developed,us,77.19,2026-10-30');
      });

      it('leaves an existing CSV untouched', () => {
        const existing = {
          getName: () => 'region-weights.csv',
          getBlob: () => ({ getDataAsString: () => 'weight_set,bucket,weight,effective_date\n' }),
          setContent: vi.fn(),
        };
        const { created } = mockWeightsFolder([existing]);
        const result = Code.ensureRegionWeightsFile();
        expect(result.created).toBe(false);
        expect(created).toHaveLength(0);
        expect(existing.setContent).not.toHaveBeenCalled();
      });
    });

    describe('installRegionWeightsTrigger', () => {
      it('installs a monthly trigger for updateRegionWeights', () => {
        const create = vi.fn(() => ({ getUniqueId: () => 'trigger-1' }));
        global.ScriptApp = {
          getProjectTriggers: vi.fn(() => []),
          deleteTrigger: vi.fn(),
          newTrigger: vi.fn(() => ({
            timeBased: () => ({ onMonthDay: () => ({ atHour: () => ({ create }) }) }),
          })),
        };
        const result = Code.installRegionWeightsTrigger();
        expect(result).toEqual({ installed: true, handler: 'updateRegionWeights', triggerId: 'trigger-1' });
        expect(global.ScriptApp.newTrigger).toHaveBeenCalledWith('updateRegionWeights');
      });
    });
  });
});
