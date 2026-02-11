import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

describe('Code.js', () => {
  beforeEach(() => {
    vi.resetAllMocks();

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

    it('should return specific file content when t parameter is provided', () => {
      const e = { parameter: { t: 'assetClassRatio' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify([{ other: 'val', amount_yen: '20' }]));
    });

    it('should be case-insensitive to extension when retrieving file via t parameter', () => {
      const e = { parameter: { t: 'other' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify([{ header1: 'val3', header2: 'val4' }]));
    });

    it('should return status true when other parameters are provided', () => {
      const e = { parameter: { unknown: 'value' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({ status: true }));
    });
  });

  describe('convertCsvToJsonInFolder', () => {
    it('should return JSON string for found file', () => {
      const result = Code.convertCsvToJsonInFolder('assetClassRatio');
      expect(result).toBe(JSON.stringify([{ other: 'val', amount_yen: '20' }]));
    });

    it('should handle case-insensitive extensions', () => {
      const result = Code.convertCsvToJsonInFolder('other');
      expect(result).toBe(JSON.stringify([{ header1: 'val3', header2: 'val4' }]));
    });

    it('should return error message for non-existent file', () => {
      const result = Code.convertCsvToJsonInFolder('nonexistent');
      expect(result).toBe(JSON.stringify({ error: 'File not found: nonexistent' }));
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
