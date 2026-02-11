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
        if (csv.includes('val1')) {
           return [['header1', 'header2'], ['val1', 'val2']];
        }
        return [['header1', 'header2'], ['val3', 'val4']];
      }),
    };

    // Mock DriveApp
    const mockFile1 = {
      getName: () => 'assetClassRatio.csv',
      getBlob: () => ({
        getDataAsString: () => 'header1,header2\nval1,val2'
      })
    };
    const mockFile2 = {
      getName: () => 'other.CSV',
      getBlob: () => ({
        getDataAsString: () => 'header1,header2\nval3,val4'
      })
    };

    const createMockFiles = (filesArray) => {
      let index = 0;
      return {
        hasNext: vi.fn(() => index < filesArray.length),
        next: vi.fn(() => filesArray[index++]),
      };
    };

    global.DriveApp = {
      getFolderById: vi.fn(() => ({
        getFilesByType: vi.fn(() => createMockFiles([mockFile1, mockFile2]))
      })),
    };
  });

  describe('doGet', () => {
    it('should return a list of filenames without .csv when no parameters are provided', () => {
      const e = { parameter: {} };
      Code.doGet(e);

      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('19PDxxar-38XMlBiYC02lDb1bJh3wJRkh');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(['assetClassRatio', 'other']));
    });

    it('should return specific file content when t parameter is provided', () => {
      const e = { parameter: { t: 'assetClassRatio' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify([{ header1: 'val1', header2: 'val2' }]));
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
      expect(result).toBe(JSON.stringify([{ header1: 'val1', header2: 'val2' }]));
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
});
