import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

describe('Formatting rules', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    global.MimeType = {
      CSV: 'text/csv',
    };

    global.Utilities = {
      parseCsv: vi.fn((csv) => {
        // Simple mock of CSV parsing
        const lines = csv.split('\n');
        return lines.map(line => line.split(','));
      }),
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
        getFilesByType: vi.fn(() => createMockFiles([
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
            getName: () => 'assetClassRatio.csv',
            getBlob: () => ({ getDataAsString: () => 'timestamp,y,other\n2023-01-01,20,val' })
          },
          {
            getName: () => 'details__portfolio_456.csv',
            getBlob: () => ({ getDataAsString: () => 'timestamp,detail_id,table_index,other\n2023-01-01,id2,1,val' })
          }
        ]))
      })),
    };
  });

  it('should apply rules for breakdown-liability', () => {
    const result = JSON.parse(Code.convertCsvToJsonInFolder('breakdown-liability'));
    expect(result[0]).toEqual({ other: 'val' });
    expect(result[0]).not.toHaveProperty('timestamp');
    expect(result[0]).not.toHaveProperty('amount_text_num');
    expect(result[0]).not.toHaveProperty('percentage_text_num');
  });

  it('should apply rules for details__liability*', () => {
    const result = JSON.parse(Code.convertCsvToJsonInFolder('details__liability_123'));
    expect(result[0]).toEqual({ other: 'val' });
    expect(result[0]).not.toHaveProperty('timestamp');
    expect(result[0]).not.toHaveProperty('detail_id');
    expect(result[0]).not.toHaveProperty('table_index');
    expect(result[0]).not.toHaveProperty('残高_yen');
  });

  it('should apply rules for total-liability', () => {
    const result = JSON.parse(Code.convertCsvToJsonInFolder('total-liability'));
    expect(result[0]).toEqual({ other: 'val' });
    expect(result[0]).not.toHaveProperty('timestamp');
    expect(result[0]).not.toHaveProperty('total_text_num');
  });

  it('should apply rules for assetClassRatio', () => {
    const result = JSON.parse(Code.convertCsvToJsonInFolder('assetClassRatio'));
    expect(result[0]).toEqual({ amount_yen: '20', other: 'val' });
    expect(result[0]).not.toHaveProperty('timestamp');
    expect(result[0]).not.toHaveProperty('y');
  });

  it('should apply rules for details__portfolio*', () => {
    const result = JSON.parse(Code.convertCsvToJsonInFolder('details__portfolio_456'));
    expect(result[0]).toEqual({ other: 'val' });
    expect(result[0]).not.toHaveProperty('timestamp');
    expect(result[0]).not.toHaveProperty('detail_id');
    expect(result[0]).not.toHaveProperty('table_index');
  });
});
