import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

const BREAKDOWN_CSV = [
  'category,amount_yen,percentage',
  '預金・現金,1000,10',
  '株式(現物),2000,20',
  '投資信託,3000,30',
  '年金,4000,40',
  'ポイント,500,5',
].join('\n');

const TOTAL_LIABILITY_CSV = [
  'timestamp,total_yen,total_text_num',
  '2026-01-01,7000,7000',
].join('\n');

const mfcfXml = (items) => `
<rss version="2.0">
  <channel>
${items.join('\n')}
  </channel>
</rss>`;

const mfcfItem = ({ date, amount, name, category, isTransfer }) => `    <item>
      <title>${date} ${amount} ${name}</title>
      <pubDate>Thu, 01 Jan 2026 00:00:00 +0000</pubDate>
      <description><![CDATA[ date: ${date} amount: ${amount} category: ${category} is_transfer: ${isTransfer} ]]></description>
    </item>`;

const MFCF_202512_XML = mfcfXml([
  mfcfItem({ date: '12/15(月)', amount: '+¥200,000', name: '給与', category: '収入/給与', isTransfer: false }),
  mfcfItem({ date: '12/10(水)', amount: '-¥50,000', name: 'ローン', category: '住宅/ローン返済', isTransfer: false }),
  mfcfItem({ date: '12/20(土)', amount: '-¥30,000', name: '外食', category: '食費/外食', isTransfer: false }),
]);

const MFCF_202601_XML = mfcfXml([
  mfcfItem({ date: '01/15(木)', amount: '+¥100,000', name: '給与', category: '収入/給与', isTransfer: false }),
  mfcfItem({ date: '01/10(土)', amount: '-¥50,000', name: 'ローン', category: '住宅/ローン返済', isTransfer: false }),
  mfcfItem({ date: '01/20(火)', amount: '-¥10,000', name: '外食', category: '食費/外食', isTransfer: false }),
  mfcfItem({ date: '01/05(月)', amount: '-¥99,999', name: '旅行', category: '特別な支出/旅行', isTransfer: false }),
  mfcfItem({ date: '01/25(日)', amount: '-¥77,777', name: '振替', category: '振替', isTransfer: true }),
]);

describe('Monthly snapshots', () => {
  let scriptProperties;
  let staticFiles;
  let snapshotContent;
  let createdFiles;

  const createIterator = (filesArray) => {
    let index = 0;
    return {
      hasNext: vi.fn(() => index < filesArray.length),
      next: vi.fn(() => filesArray[index++]),
    };
  };

  const staticFile = (name, content) => ({
    getName: () => name,
    getBlob: () => ({ getDataAsString: () => content }),
  });

  const snapshotFile = () => ({
    getName: () => 'snapshots.csv',
    getBlob: () => ({ getDataAsString: () => snapshotContent }),
    setContent: vi.fn((content) => {
      snapshotContent = content;
    }),
  });

  const currentFiles = () => {
    const files = [...staticFiles];
    if (snapshotContent !== null) {
      files.push(snapshotFile());
    }
    return files;
  };

  beforeEach(() => {
    vi.resetAllMocks();

    scriptProperties = {
      DEBUG: 'true',
      NO_CACHE: 'true',
      AVAILABLE_GMAILS: 'allowed@example.com',
      GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    };

    global.PropertiesService = {
      getScriptProperties: vi.fn(() => ({
        getProperty: vi.fn((key) => scriptProperties[key] ?? ''),
      })),
    };

    const mockTextOutput = {
      setMimeType: vi.fn().mockReturnThis(),
      getContent: vi.fn(),
    };
    global.ContentService = {
      MimeType: { JSON: 'application/json' },
      createTextOutput: vi.fn().mockReturnValue(mockTextOutput),
    };

    global.CacheService = {
      getScriptCache: vi.fn(() => ({
        get: vi.fn(() => null),
        removeAll: vi.fn(),
        put: vi.fn(),
      })),
    };

    global.Utilities = {
      parseCsv: vi.fn((csv) => {
        if (!csv) return [[]];
        const lines = csv.split('\n').filter((line) => line.trim() !== '');
        return lines.map((line) => line.split(','));
      }),
    };

    // Same lightweight RSS mock as Code.spec.js.
    global.XmlService = {
      parse: vi.fn((xml) => {
        const items = [];
        if (xml.includes('<item>')) {
          const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
          itemMatches.forEach((itemXml) => {
            const title = itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
            const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
            const description = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
            items.push({
              getChildText: (name) => {
                if (name === 'title') return title;
                if (name === 'pubDate') return pubDate;
                if (name === 'description') return description;
                return '';
              },
            });
          });
        }
        return {
          getRootElement: () => ({
            getChild: (name) => {
              if (name === 'channel') {
                return {
                  getChildren: (childName) => (childName === 'item' ? items : []),
                };
              }
              return null;
            },
          }),
        };
      }),
    };

    global.Logger = { log: vi.fn() };

    staticFiles = [
      staticFile('breakdown.csv', BREAKDOWN_CSV),
      staticFile('total-liability.csv', TOTAL_LIABILITY_CSV),
      staticFile('mfcf.202512.xml', MFCF_202512_XML),
      staticFile('mfcf.202601.xml', MFCF_202601_XML),
    ];
    snapshotContent = null;
    createdFiles = [];

    global.DriveApp = {
      getFolderById: vi.fn(() => ({
        getFiles: vi.fn(() => createIterator(currentFiles())),
        getFilesByName: vi.fn((name) =>
          createIterator(currentFiles().filter((file) => file.getName() === name))),
        createFile: vi.fn((name, content) => {
          createdFiles.push({ name, content });
          if (name === 'snapshots.csv') {
            snapshotContent = content;
          }
          return staticFile(name, content);
        }),
      })),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('computeSnapshotRow_', () => {
    it('sums breakdown rows and reads the liability total like the balance sheet', () => {
      const row = Code.computeSnapshotRow_(
        {
          breakdown: [
            { category: '預金・現金', amount_yen: '1000' },
            { category: '株式(現物)', amount_yen: '2000' },
            { category: '投資信託', amount_yen: '3000' },
            { category: '年金', amount_yen: '4000' },
            { category: 'ポイント', amount_yen: '500' },
          ],
          'total-liability': [{ total_yen: '7000' }],
        },
        [],
        '2026-01',
      );

      expect(row).toEqual({
        month: '2026-01',
        total_assets: 10500,
        total_liabilities: 7000,
        net_assets: 3500,
        cash: 1000,
        risk_assets: 9000,
        living_cost_12m_avg: 0,
        income_12m_avg: 0,
      });
    });

    it('includes equity variants and crypto in risk assets, matching the Money Forward category names', () => {
      const row = Code.computeSnapshotRow_(
        {
          breakdown: [
            { category: '預金・現金', amount_yen: '1000' },
            { category: '株式(現物)', amount_yen: '2000' },
            { category: '株式(信用)', amount_yen: '700' },
            { category: '投資信託', amount_yen: '3000' },
            { category: '暗号資産', amount_yen: '600' },
            { category: '年金', amount_yen: '4000' },
            { category: 'ポイント', amount_yen: '500' },
          ],
          'total-liability': [{ total_yen: '0' }],
        },
        [],
        '2026-01',
      );

      expect(row.total_assets).toBe(11800);
      expect(row.cash).toBe(1000);
      expect(row.risk_assets).toBe(10300);
    });

    it('tolerates missing datasets', () => {
      const row = Code.computeSnapshotRow_({}, [], '2026-01');
      expect(row.total_assets).toBe(0);
      expect(row.total_liabilities).toBe(0);
      expect(row.net_assets).toBe(0);
    });
  });

  describe('computeSnapshotAverages_', () => {
    const entries = [
      { date: '2025-12-15', amount: 200000, category: '収入/給与', is_transfer: false },
      { date: '2025-12-10', amount: -50000, category: '住宅/ローン返済', is_transfer: false },
      { date: '2025-12-20', amount: -30000, category: '食費/外食', is_transfer: false },
      { date: '2026-01-15', amount: 100000, category: '収入/給与', is_transfer: false },
      { date: '2026-01-10', amount: -50000, category: '住宅/ローン返済', is_transfer: false },
      { date: '2026-01-20', amount: -10000, category: '食費/外食', is_transfer: false },
      // excluded from living cost: special expense and cash/card categories
      { date: '2026-01-05', amount: -99999, category: '特別な支出/旅行', is_transfer: false },
      { date: '2026-01-06', amount: -8888, category: '現金・カード/カード引き落とし', is_transfer: false },
      // transfers are ignored entirely
      { date: '2026-01-25', amount: -77777, category: '振替', is_transfer: true },
      { date: '2026-01-26', amount: 55555, category: '振替', is_transfer: true },
      // outside the trailing-12-month window for 2026-01
      { date: '2025-01-15', amount: 999999, category: '収入/給与', is_transfer: false },
    ];

    it('averages income and living cost over the months present in the window', () => {
      const result = Code.computeSnapshotAverages_(entries, '2026-01');
      expect(result.monthCount).toBe(2);
      expect(result.incomeAverage).toBe(150000);
      expect(result.livingCostAverage).toBe(70000);
    });

    it('returns zeros when the window has no entries', () => {
      const result = Code.computeSnapshotAverages_(entries, '2030-06');
      expect(result).toEqual({ livingCostAverage: 0, incomeAverage: 0, monthCount: 0 });
    });
  });

  describe('classifySnapshotExpenseType_', () => {
    it('mirrors the client classification rules', () => {
      expect(Code.classifySnapshotExpenseType_({ category: '住宅/ローン返済', is_transfer: false })).toBe('fixed');
      expect(Code.classifySnapshotExpenseType_({ category: '食費/食費', is_transfer: false })).toBe('fixed');
      expect(Code.classifySnapshotExpenseType_({ category: '食費/外食', is_transfer: false })).toBe('variable');
      expect(Code.classifySnapshotExpenseType_({ category: '特別な支出/旅行', is_transfer: false })).toBe('exclude');
      expect(Code.classifySnapshotExpenseType_({ category: '電子マネー/チャージ', is_transfer: false })).toBe('exclude');
      expect(Code.classifySnapshotExpenseType_({ category: '食費/外食', is_transfer: true })).toBe('exclude');
    });
  });

  describe('createSnapshotForMonth', () => {
    it('creates snapshots.csv with the computed row', () => {
      const row = Code.createSnapshotForMonth('2026-01');

      expect(row).toEqual({
        month: '2026-01',
        total_assets: 10500,
        total_liabilities: 7000,
        net_assets: 3500,
        cash: 1000,
        risk_assets: 9000,
        living_cost_12m_avg: 70000,
        income_12m_avg: 150000,
      });
      expect(createdFiles).toHaveLength(1);
      expect(createdFiles[0].name).toBe('snapshots.csv');
      expect(snapshotContent).toBe(
        'month,total_assets,total_liabilities,net_assets,cash,risk_assets,living_cost_12m_avg,income_12m_avg\n'
        + '2026-01,10500,7000,3500,1000,9000,70000,150000\n',
      );
    });

    it('accepts a compact YYYYMM month key', () => {
      const row = Code.createSnapshotForMonth('202601');
      expect(row.month).toBe('2026-01');
    });

    it('rejects an invalid month key', () => {
      expect(() => Code.createSnapshotForMonth('2026/01')).toThrow('invalid month key');
    });

    it('replaces the row for an existing month instead of appending a duplicate', () => {
      snapshotContent = [
        'month,total_assets,total_liabilities,net_assets,cash,risk_assets,living_cost_12m_avg,income_12m_avg',
        '2025-12,1,2,3,4,5,6,7',
        '2026-01,1,2,3,4,5,6,7',
        '',
      ].join('\n');

      Code.createSnapshotForMonth('2026-01');

      const lines = snapshotContent.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('2025-12,1,2,3,4,5,6,7');
      expect(lines[2]).toBe('2026-01,10500,7000,3500,1000,9000,70000,150000');
      expect(createdFiles).toHaveLength(0);
    });

    it('defaults to the current month when no month is given', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 10, 9, 0, 0));

      const row = Code.createSnapshotForMonth();
      expect(row.month).toBe('2026-11');
    });
  });

  describe('createMonthlySnapshot', () => {
    it('targets the previous month', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 11, 1, 8, 0, 0));

      const row = Code.createMonthlySnapshot();
      expect(row.month).toBe('2026-11');
      expect(snapshotContent).toContain('2026-11,10500,7000,3500,1000,9000,');
    });
  });

  describe('installMonthlySnapshotTrigger', () => {
    it('replaces existing triggers for the same handler and installs a monthly one', () => {
      const deleted = [];
      const existing = [
        { getHandlerFunction: () => 'createMonthlySnapshot', id: 'old-1' },
        { getHandlerFunction: () => 'otherHandler', id: 'old-2' },
      ];
      const builder = {
        timeBased: vi.fn().mockReturnThis(),
        onMonthDay: vi.fn().mockReturnThis(),
        atHour: vi.fn().mockReturnThis(),
        create: vi.fn(() => ({ getUniqueId: () => 'new-trigger-id' })),
      };
      global.ScriptApp = {
        getProjectTriggers: vi.fn(() => existing),
        deleteTrigger: vi.fn((trigger) => deleted.push(trigger)),
        newTrigger: vi.fn(() => builder),
      };

      const result = Code.installMonthlySnapshotTrigger();

      expect(deleted).toEqual([existing[0]]);
      expect(global.ScriptApp.newTrigger).toHaveBeenCalledWith('createMonthlySnapshot');
      expect(builder.onMonthDay).toHaveBeenCalledWith(1);
      expect(builder.atHour).toHaveBeenCalledWith(7);
      expect(result).toEqual({
        installed: true,
        handler: 'createMonthlySnapshot',
        triggerId: 'new-trigger-id',
      });
    });
  });

  describe('doGet response', () => {
    it('includes the snapshots key through the generic CSV pipeline', () => {
      snapshotContent = [
        'month,total_assets,total_liabilities,net_assets,cash,risk_assets,living_cost_12m_avg,income_12m_avg',
        '2026-01,10500,7000,3500,1000,9000,70000,150000',
        '',
      ].join('\n');

      Code.doGet({ parameter: {} });

      const payload = JSON.parse(
        global.ContentService.createTextOutput.mock.calls.at(-1)[0],
      );
      expect(payload.snapshots).toEqual([
        {
          month: '2026-01',
          total_assets: '10500',
          total_liabilities: '7000',
          net_assets: '3500',
          cash: '1000',
          risk_assets: '9000',
          living_cost_12m_avg: '70000',
          income_12m_avg: '150000',
        },
      ]);
    });
  });
});
