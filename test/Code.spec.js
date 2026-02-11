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

    // Mock DriveApp
    const mockFile1 = { getName: () => 'assetClassRatio.csv' };
    const mockFile2 = { getName: () => 'other.CSV' };
    const mockFiles = {
      hasNext: vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(true)
        .mockReturnValue(false),
      next: vi.fn()
        .mockReturnValueOnce(mockFile1)
        .mockReturnValueOnce(mockFile2),
    };
    const mockFolder = {
      getFilesByType: vi.fn().mockReturnValue(mockFiles),
    };
    global.DriveApp = {
      getFolderById: vi.fn().mockReturnValue(mockFolder),
    };
  });

  describe('doGet', () => {
    it('should return a list of filenames without .csv when no parameters are provided', () => {
      const e = { parameter: {} };
      Code.doGet(e);

      expect(global.DriveApp.getFolderById).toHaveBeenCalledWith('19PDxxar-38XMlBiYC02lDb1bJh3wJRkh');
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(['assetClassRatio', 'other']));
    });

    it('should return status true when parameters are provided', () => {
      const e = { parameter: { key: 'value' } };
      Code.doGet(e);

      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify({ status: true }));
    });

    it('should handle undefined e or e.parameter', () => {
      Code.doGet(undefined);
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(['assetClassRatio', 'other']));

      Code.doGet({});
      expect(global.ContentService.createTextOutput).toHaveBeenCalledWith(JSON.stringify(['assetClassRatio', 'other']));
    });
  });
});
