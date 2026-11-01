import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      no_cache: true,
    };
    it('should return all CSV data keyed by filename when no parameters are provided', () => {
      const e = { parameter: {} };
      Code.doGet(e);

      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('19PDxxar-38XMlBiYC02lDb1bJh3wJRkh');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
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
        no_cache: false,
      }));
      expect(global.DriveApp.getFolderById).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('should bypass cache reads when NO_CACHE is true', () => {
      scriptProperties.NO_CACHE = 'true';
      const cache = global.CacheService.getScriptCache();

      Code.doGet({ parameter: {} });

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

      Code.doGet({ parameter: {} });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });





    it('should fallback to folder data when CacheService is unavailable', () => {
      delete global.CacheService;

      Code.doGet({ parameter: {} });

      expect(global.DriveApp.getFolderById).toHaveBeenCalled();
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
    });

    it('should return all CSV data when other parameters are provided', () => {
      const e = { parameter: { unknown: 'value' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(EXPECTED_LIVE_DATA_RESPONSE));
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

  describe('share sessions', () => {
    const SHARE_HEADERS = [
      'token_hash',
      'issued_at',
      'expires_at',
      'revoked_at',
      'access_count',
      'last_accessed_at',
    ];
    let shareValues;
    let shareSheetExists;
    let mockShareSheet;
    let mockShareSpreadsheet;
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

    const folderWithShareFile = () => {
      global.MimeType = {
        CSV: 'text/csv',
        GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
      };
      const shareFile = {
        getName: () => 'asset-share-sessions',
        getMimeType: () => 'application/vnd.google-apps.spreadsheet',
        getId: () => 'share-spreadsheet-id',
      };
      return {
        getFiles: vi.fn(() => createMockFiles([])),
        getFilesByName: vi.fn(() => createMockFiles([shareFile])),
      };
    };

    beforeEach(() => {
      scriptProperties.DEBUG = 'false';
      scriptProperties.SHARE_SPREADSHEET_ID = 'share-spreadsheet-id';
      uuidCounter = 0;
      shareValues = [[...SHARE_HEADERS]];
      shareSheetExists = true;

      mockShareSheet = {
        getDataRange: vi.fn(() => ({ getValues: vi.fn(() => shareValues) })),
        appendRow: vi.fn((row) => { shareValues.push([...row]); }),
        getRange: vi.fn((row, col) => ({
          setValue: vi.fn((value) => { shareValues[row - 1][col - 1] = value; }),
        })),
      };
      mockShareSpreadsheet = {
        getId: vi.fn(() => 'share-spreadsheet-id'),
        getSheetByName: vi.fn(() => (shareSheetExists ? mockShareSheet : null)),
        insertSheet: vi.fn(() => { shareSheetExists = true; return mockShareSheet; }),
      };
      global.SpreadsheetApp = {
        openById: vi.fn(() => mockShareSpreadsheet),
        create: vi.fn(() => mockShareSpreadsheet),
      };
      global.Utilities = {
        ...global.Utilities,
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        computeDigest: vi.fn((algo, str) =>
          Array.from({ length: 32 }, (_, i) => String(str).charCodeAt(i % String(str).length) % 128)),
        getUuid: vi.fn(() => `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`),
      };
      global.PropertiesService = {
        getScriptProperties: vi.fn(() => ({
          getProperty: vi.fn((key) => scriptProperties[key] ?? ''),
          setProperty: vi.fn((key, value) => { scriptProperties[key] = value; }),
        })),
      };
    });

    it('requires an ID token to issue a share session', () => {
      Code.doGet({ parameter: { action: 'issue_share' }, headers: {} });
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
      expect(shareValues).toHaveLength(2);
      expect(shareValues[1][0]).toBe(shareHashOf(token));
      expect(shareValues[1][0]).not.toBe(token);
      expect(shareValues[1][4]).toBe(0);
    });

    it('creates the share sheet with headers when it does not exist yet', () => {
      shareValues = [];
      shareSheetExists = false;
      issueToken();
      expect(mockShareSpreadsheet.insertSheet).toHaveBeenCalledWith('share_sessions');
      expect(shareValues[0]).toEqual(SHARE_HEADERS);
      expect(shareValues).toHaveLength(2);
    });

    it('revokes the previous session when a new one is issued', () => {
      const first = issueToken();
      const second = issueToken();
      expect(first).not.toBe(second);
      expect(shareValues[1][3]).not.toBe('');
      expect(shareValues[2][3]).toBe('');
      Code.doGet({ parameter: { share_token: first } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('serves data with a valid share token and counts the access', () => {
      const token = issueToken();
      Code.doGet({ parameter: { share_token: token } });
      const data = lastJson();
      expect(data.assetClassRatio).toEqual([{ other: 'val', amount_yen: '20' }]);
      expect(data._share.expires_at).toBe(shareValues[1][2]);
      expect(shareValues[1][4]).toBe(1);
      expect(shareValues[1][5]).not.toBe('');
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
      expect(data._share.expires_at).toBe(shareValues[1][2]);
    });

    it('rejects an expired share token', () => {
      const token = 'expired-token';
      shareValues.push([
        shareHashOf(token),
        new Date(Date.now() - 3600_000).toISOString(),
        new Date(Date.now() - 1800_000).toISOString(),
        '',
        0,
        '',
      ]);
      Code.doGet({ parameter: { share_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('rejects a revoked share token', () => {
      const token = 'revoked-token';
      shareValues.push([
        shareHashOf(token),
        new Date().toISOString(),
        new Date(Date.now() + 1800_000).toISOString(),
        new Date().toISOString(),
        0,
        '',
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
      Code.doGet({ parameter: { share_token: token } });
      expect(lastJson()).toEqual({ status: 401, error: 'share session expired or invalid' });
    });

    it('finds the share spreadsheet in the data folder when no ID is stored', () => {
      delete scriptProperties.SHARE_SPREADSHEET_ID;
      global.DriveApp.getFolderById.mockReturnValue(folderWithShareFile());
      issueToken();
      expect(global.SpreadsheetApp.openById).toHaveBeenCalledWith('share-spreadsheet-id');
      expect(scriptProperties.SHARE_SPREADSHEET_ID).toBe('share-spreadsheet-id');
    });

    it('falls back to the folder search when the stored spreadsheet is gone', () => {
      global.SpreadsheetApp.openById.mockImplementationOnce(() => {
        throw new Error('not found');
      });
      global.DriveApp.getFolderById.mockReturnValue(folderWithShareFile());
      issueToken();
      expect(global.SpreadsheetApp.openById).toHaveBeenCalledWith('share-spreadsheet-id');
      expect(shareValues).toHaveLength(2);
    });

    it('creates the share spreadsheet in the data folder when none exists', () => {
      delete scriptProperties.SHARE_SPREADSHEET_ID;
      global.MimeType = {
        CSV: 'text/csv',
        GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
      };
      global.DriveApp.getFolderById.mockReturnValue({
        getFiles: vi.fn(() => createMockFiles([])),
        getFilesByName: vi.fn(() => createMockFiles([])),
      });
      global.DriveApp.getFileById = vi.fn(() => ({ moveTo: vi.fn() }));
      issueToken();
      expect(global.SpreadsheetApp.create).toHaveBeenCalledWith('asset-share-sessions');
      expect(global.DriveApp.getFileById).toHaveBeenCalledWith('share-spreadsheet-id');
      expect(scriptProperties.SHARE_SPREADSHEET_ID).toBe('share-spreadsheet-id');
    });

    it('still issues when moving the new spreadsheet into the folder fails', () => {
      delete scriptProperties.SHARE_SPREADSHEET_ID;
      global.DriveApp.getFolderById.mockReturnValue({
        getFiles: vi.fn(() => createMockFiles([])),
        getFilesByName: vi.fn(() => createMockFiles([])),
      });
      global.DriveApp.getFileById = vi.fn(() => ({
        moveTo: vi.fn(() => { throw new Error('cannot move'); }),
      }));
      const token = issueToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
