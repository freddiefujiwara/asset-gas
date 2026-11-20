import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// Abnormal-case tests: the "input from outside" for asset-gas is
// Money Forward-derived data (mfcf XML feeds, CSV exports of
// balances / holdings) and spreadsheet-style cell values. Those
// values are strings in the real pipeline, but the payload can
// also arrive as cached JSON, where a field can hold any JSON
// value — including an object whose toString is not callable
// (producible via JSON: {"toString": []}), which makes String()
// throw. A deformed row must never kill the whole payload, an
// invented amount must never appear, and a date that does not
// exist must never be recorded as a real one.
const BAD = { toString: [] };

const emptyFileIterator = () => {
  const files = [];
  let index = 0;
  return { hasNext: () => index < files.length, next: () => files[index++] };
};

beforeEach(() => {
  vi.resetAllMocks();
  global.Logger = { log: vi.fn() };
});

// Minimal XmlService / DriveApp mocks mirroring test/Code.spec.js,
// so the mfcf XML parsing path (including its date handling) can
// be driven with deformed feed entries.
const setupXmlFeed = (fileName, itemsXml) => {
  global.XmlService = {
    parse: vi.fn((xml) => {
      const items = [];
      const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      itemMatches.forEach((itemXml) => {
        const title = itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
        const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const description =
          itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
        items.push({
          getChildText: (name) =>
            name === 'title' ? title : name === 'pubDate' ? pubDate : description,
        });
      });
      return {
        getRootElement: () => ({
          getChild: (name) =>
            name === 'channel' ? { getChildren: () => items } : null,
        }),
      };
    }),
  };
  const files = [
    {
      getName: () => fileName,
      getBlob: () => ({
        getDataAsString: () =>
          `<rss version="2.0"><channel>${itemsXml}</channel></rss>`,
      }),
    },
  ];
  let index = 0;
  global.DriveApp = {
    getFolderById: vi.fn(() => ({
      getFiles: () => ({
        hasNext: () => index < files.length,
        next: () => files[index++],
      }),
    })),
  };
};

const feedItem = (pubDate, description) =>
  `<item><title>02/12(木) -¥3,000 TEST</title><pubDate>${pubDate}</pubDate>` +
  `<description><![CDATA[ ${description} ]]></description></item>`;

describe('mfcf XML dates that do not exist', () => {
  it('drops an explicit pubDate of 2026-02-30 instead of recording it verbatim', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('2026-02-30', 'date: 02/12(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('');
  });

  it('drops a description date of 02/30 instead of rolling it into a real day', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('Thu, 12 Feb 2026 00:00:00 +0000', 'date: 02/30(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('');
  });

  it('drops a pubDate with month 13', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('2026-13-01', 'date: 02/12(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('');
  });

  it('drops a pubDate of 2026-04-31 (April has 30 days)', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('2026-04-31', 'date: 02/12(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('');
  });

  it('drops 02/29 in a non-leap year file', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('Thu, 12 Feb 2026 00:00:00 +0000', 'date: 02/29(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('');
  });

  it('keeps 2024-02-29, which exists (leap year)', () => {
    setupXmlFeed('mfcf.202402.xml', feedItem('2024-02-29', 'date: 02/29(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('2024-02-29');
  });

  it('keeps 02/29 from a leap-year file', () => {
    setupXmlFeed('mfcf.202402.xml', feedItem('Thu, 29 Feb 2024 00:00:00 +0000', 'date: 02/29(木) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('2024-02-29');
  });

  it('keeps an ordinary pubDate', () => {
    setupXmlFeed('mfcf.202602.xml', feedItem('2026-02-28', 'date: 02/28(土) amount: -¥3,000 category: C is_transfer: false'));
    expect(Code.getAllXmlDataEntries_()[0].date).toBe('2026-02-28');
  });
});

describe('dashboardNormalizePortfolio_ with deformed payloads', () => {
  it('does not throw when a breakdown category cannot be stringified', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      breakdown: [{ category: BAD, amount_yen: '100', percentage: '1' }],
    });
    expect(portfolio.summary.assetsByClass[0].name).toBe('');
    expect(portfolio.totals.assetsYen).toBe(100);
  });

  it('does not throw when a liability category cannot be stringified', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      'breakdown-liability': [{ category: BAD, amount_yen: '100', percentage: '1' }],
    });
    expect(portfolio.summary.liabilitiesByCategory[0].category).toBe('');
  });

  it('does not throw when a cash-flow name cannot be stringified', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      mfcf: [{ date: '2026-01-01', amount: '-100', name: BAD, category: '食費/食費', is_transfer: false }],
    });
    expect(portfolio.cashFlow[0].name).toBe('');
    expect(portfolio.cashFlow[0].amount).toBe(-100);
  });

  it('does not throw when a cash-flow date cannot be stringified', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      mfcf: [{ date: BAD, amount: '-100', name: '店', category: '食費/食費', is_transfer: false }],
    });
    expect(portfolio.cashFlow[0].date).toBe('');
  });

  it('does not throw when a snapshot month cannot be stringified, and drops the row', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      snapshots: [{ month: BAD, total_assets: '100' }],
    });
    expect(portfolio.snapshots).toEqual([]);
  });

  it('keeps the well-formed rows when one row is deformed', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      breakdown: [
        { category: '預金・現金', amount_yen: '1000', percentage: '10' },
        { category: BAD, amount_yen: '2000', percentage: '20' },
        { category: '投資信託', amount_yen: '3000', percentage: '30' },
      ],
    });
    expect(portfolio.totals.assetsYen).toBe(6000);
    expect(portfolio.summary.assetsByClass).toHaveLength(3);
  });

  it('reads amounts through the documented parse rules', () => {
    const totalOf = (amount_yen) =>
      Code.dashboardNormalizePortfolio_({
        breakdown: [{ category: '株式(現物)', amount_yen, percentage: '1' }],
      }).totals.assetsYen;
    expect(totalOf('1,200')).toBe(1200);
    expect(totalOf('¥3,000')).toBe(3000);
    expect(totalOf('￥3,000')).toBe(3000);
    expect(totalOf('(3,000)')).toBe(-3000);
    expect(totalOf('▲3,000')).toBe(-3000);
    expect(totalOf('3,000円')).toBe(3000);
    expect(totalOf('abc')).toBe(0);
    expect(totalOf('')).toBe(0);
  });

  it('never invents an amount from a non-numeric cell value', () => {
    const totalOf = (amount_yen) =>
      Code.dashboardNormalizePortfolio_({
        breakdown: [{ category: '株式(現物)', amount_yen, percentage: '1' }],
      }).totals.assetsYen;
    expect(totalOf(true)).toBe(0);
    expect(totalOf([500])).toBe(0);
    expect(totalOf(BAD)).toBe(0);
    expect(totalOf(new Date(2026, 0, 1))).toBe(0);
    expect(totalOf(null)).toBe(0);
    expect(totalOf(undefined)).toBe(0);
  });

  it('pins the percent parser asymmetry: commas are not stripped there', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      breakdown: [{ category: '株式(現物)', amount_yen: '100', percentage: '1,200' }],
    });
    expect(portfolio.summary.assetsByClass[0].percentage).toBe(0);
    const signed = Code.dashboardNormalizePortfolio_({
      breakdown: [{ category: '株式(現物)', amount_yen: '100', percentage: '(2.5)' }],
    });
    expect(signed.summary.assetsByClass[0].percentage).toBe(-2.5);
  });

  it('tolerates non-array sections and non-object rows', () => {
    const portfolio = Code.dashboardNormalizePortfolio_({
      breakdown: 'not-an-array',
      'total-liability': 'also-not-an-array',
      mfcf: [null, 42, 'x'],
      snapshots: [null],
    });
    expect(portfolio.totals).toEqual({ assetsYen: 0, liabilitiesYen: 0, netWorthYen: 0 });
    // The three non-object rows all normalize to the same empty
    // row, which the documented dedupe then collapses into one.
    expect(portfolio.cashFlow).toHaveLength(1);
    expect(portfolio.snapshots).toEqual([]);
  });

  it('collapses exact duplicate cash-flow rows', () => {
    const row = { date: '2026-01-05', amount: '-100', name: '店', category: '食費/食費', is_transfer: false };
    const portfolio = Code.dashboardNormalizePortfolio_({ mfcf: [row, { ...row }, { ...row, amount: '-200' }] });
    expect(portfolio.cashFlow).toHaveLength(2);
  });
});

describe('buildDashboardRssItem_ with degenerate portfolios', () => {
  it('builds an item for an empty portfolio object instead of throwing', () => {
    const item = Code.buildDashboardRssItem_({}, Date.parse('2026-11-17T00:00:00Z'));
    expect(item).not.toBeNull();
    expect(item.guid).toMatch(/^asset-dashboard-\d{4}-\d{2}-\d{2}$/);
    expect(item.descriptionText).toContain('純資産 ¥0');
  });

  it('returns null for a missing portfolio', () => {
    expect(Code.buildDashboardRssItem_(null, Date.parse('2026-11-17T00:00:00Z'))).toBeNull();
    expect(Code.buildDashboardRssItem_(undefined, Date.parse('2026-11-17T00:00:00Z'))).toBeNull();
  });
});

describe('applyFormattingRules with deformed type names', () => {
  it('does not throw when the type name is missing', () => {
    expect(Code.applyFormattingRules([{ a: 1 }], undefined)).toEqual([{ a: 1 }]);
    expect(Code.applyFormattingRules([{ a: 1 }], null)).toEqual([{ a: 1 }]);
  });

  it('does not throw when the type name is not a string', () => {
    expect(Code.applyFormattingRules([{ a: 1 }], 42)).toEqual([{ a: 1 }]);
    expect(Code.applyFormattingRules([{ a: 1 }], BAD)).toEqual([{ a: 1 }]);
  });

  it('still applies the matching rule for a real type name', () => {
    const rows = [{ timestamp: 't', y: 20, other: 'v' }];
    expect(Code.applyFormattingRules(rows, 'assetClassRatio')).toEqual([{ other: 'v', amount_yen: 20 }]);
  });
});

describe('month keys that do not exist', () => {
  it('rejects month 13 when creating a snapshot', () => {
    global.DriveApp = {
      getFolderById: vi.fn(() => ({
        getFiles: emptyFileIterator,
        getFilesByName: () => ({ hasNext: () => false, next: () => null }),
        createFile: vi.fn(),
      })),
    };
    expect(() => Code.createSnapshotForMonth('2026-13')).toThrow(/invalid month key/);
  });

  it('rejects month 00 when creating a snapshot', () => {
    global.DriveApp = {
      getFolderById: vi.fn(() => ({
        getFiles: emptyFileIterator,
        getFilesByName: () => ({ hasNext: () => false, next: () => null }),
        createFile: vi.fn(),
      })),
    };
    expect(() => Code.createSnapshotForMonth('202600')).toThrow(/invalid month key/);
  });

  it('treats a mortgage payoff month of 2042-13 as no schedule', () => {
    expect(
      Code.dashboardProjectLiabilitiesYen_({
        currentLiabilitiesYen: 1200000,
        mortgageMonthlyPayment: 100000,
        mortgagePayoffDate: '2042-13',
        startMonthKey: '2026-11',
        monthOffset: 6,
      }),
    ).toBe(1200000);
  });

  it('treats a mortgage payoff month of 2042-00 as no schedule', () => {
    expect(
      Code.dashboardProjectLiabilitiesYen_({
        currentLiabilitiesYen: 1200000,
        mortgageMonthlyPayment: 100000,
        mortgagePayoffDate: '2042-00',
        startMonthKey: '2026-11',
        monthOffset: 6,
      }),
    ).toBe(1200000);
  });

  it('keeps the declining schedule for a real payoff month', () => {
    expect(
      Code.dashboardProjectLiabilitiesYen_({
        currentLiabilitiesYen: 1200000,
        mortgageMonthlyPayment: 100000,
        mortgagePayoffDate: '2042-05',
        startMonthKey: '2026-11',
        monthOffset: 6,
      }),
    ).toBe(600000);
  });

  it('ignores a snapshot row whose month does not exist in the projection trend', () => {
    const baseParams = { currentAge: 47, monthlyExpense: 200000, monthlyIncome: 400000 };
    const trend = Code.dashboardBuildProjectionTrend_(
      [
        {
          month: '2026-13',
          totalAssetsYen: 5000000,
          totalLiabilitiesYen: 0,
          netAssetsYen: 5000000,
          cashYen: 1000000,
          riskAssetsYen: 4000000,
          livingCost12mAvgYen: 0,
          income12mAvgYen: 0,
        },
      ],
      { baseParams },
    );
    expect(trend.points).toEqual([]);
    expect(trend.hasTrend).toBe(false);
  });
});

describe('parseMsciFactsheet_ with dates that do not exist', () => {
  const sheet = (dateText) =>
    `COUNTRY WEIGHTS United States 64.63 % Japan 5.08 % ${dateText}`;

  it('rejects a factsheet dated OCT 32', () => {
    expect(Code.parseMsciFactsheet_(sheet('OCT 32, 2026 OCT 32, 2026'))).toBeNull();
  });

  it('rejects a factsheet dated FEB 30', () => {
    expect(Code.parseMsciFactsheet_(sheet('FEB 30, 2026'))).toBeNull();
  });

  it('rejects a factsheet dated 31 APR', () => {
    expect(Code.parseMsciFactsheet_(sheet('31 APR 2026'))).toBeNull();
  });

  it('accepts FEB 29 in a leap year', () => {
    expect(Code.parseMsciFactsheet_(sheet('FEB 29, 2024'))).toEqual({
      asOf: '2024-02-29',
      us: 64.63,
      japan: 5.08,
    });
  });

  it('accepts an ordinary date', () => {
    expect(Code.parseMsciFactsheet_(sheet('OCT 30, 2026'))).toEqual({
      asOf: '2026-10-30',
      us: 64.63,
      japan: 5.08,
    });
  });
});

describe('parseRegionWeightsRows_ with deformed rows', () => {
  it('does not throw when a weight_set cannot be stringified', () => {
    expect(
      Code.parseRegionWeightsRows_([{ weight_set: BAD, bucket: 'japan', weight: '5' }]),
    ).toBeNull();
  });

  it('does not throw when a bucket cannot be stringified', () => {
    expect(
      Code.parseRegionWeightsRows_([{ weight_set: 'acwi', bucket: BAD, weight: '5' }]),
    ).toBeNull();
  });

  it('does not throw when an effective_date cannot be stringified', () => {
    const sets = Code.parseRegionWeightsRows_([
      { weight_set: 'acwi', bucket: 'japan', weight: '5', effective_date: BAD },
    ]);
    expect(sets.acwi.japan).toBe(5);
    expect(sets.acwi.effective_date).toBe('');
  });

  it('does not throw when a weight cannot be converted to a number', () => {
    // Found by the property suite: a bare Number() throws on an
    // object whose toString is not callable.
    expect(
      Code.parseRegionWeightsRows_([{ weight_set: 'acwi', bucket: 'japan', weight: BAD }]),
    ).toBeNull();
    expect(
      Code.parseRegionWeightsRows_([{ weight_set: 'acwi', bucket: 'japan', weight: true }]),
    ).toBeNull();
  });

  it('skips rows whose weight is not a number, and negative weights', () => {
    const sets = Code.parseRegionWeightsRows_([
      { weight_set: 'acwi', bucket: 'japan', weight: 'abc' },
      { weight_set: 'acwi', bucket: 'us', weight: '-5' },
      { weight_set: 'acwi', bucket: 'emerging', weight: '11.5' },
    ]);
    expect(sets.acwi.japan).toBe(0);
    expect(sets.acwi.us).toBe(0);
    expect(sets.acwi.emerging).toBe(11.5);
  });
});

describe('snapshot computation with deformed cells', () => {
  it('does not throw when a breakdown category cannot be stringified', () => {
    const row = Code.computeSnapshotRow_(
      {
        breakdown: [
          { category: BAD, amount_yen: '100' },
          { category: '預金・現金', amount_yen: '1000' },
        ],
      },
      [],
      '2026-11',
    );
    expect(row.total_assets).toBe(1100);
    expect(row.cash).toBe(1000);
  });

  it('reads an unstringifiable amount as 0 instead of throwing', () => {
    const row = Code.computeSnapshotRow_(
      { breakdown: [{ category: '預金・現金', amount_yen: BAD }] },
      [],
      '2026-11',
    );
    expect(row.total_assets).toBe(0);
    expect(row.cash).toBe(0);
  });

  it('never invents an amount from a Date cell or an array cell', () => {
    const fromDate = Code.computeSnapshotRow_(
      { breakdown: [{ category: '預金・現金', amount_yen: new Date(2026, 0, 1) }] },
      [],
      '2026-11',
    );
    expect(fromDate.total_assets).toBe(0);
    const fromArray = Code.computeSnapshotRow_(
      { breakdown: [{ category: '預金・現金', amount_yen: [500] }] },
      [],
      '2026-11',
    );
    expect(fromArray.total_assets).toBe(0);
  });

  it('still parses comma and yen-marked amounts in snapshot rows', () => {
    const row = Code.computeSnapshotRow_(
      {
        breakdown: [{ category: '預金・現金', amount_yen: '1,200' }],
        'total-liability': [{ total_yen: '¥3,000' }],
      },
      [],
      '2026-11',
    );
    expect(row.total_assets).toBe(1200);
    expect(row.total_liabilities).toBe(3000);
  });

  it('does not invent income from array or boolean amounts in the averages', () => {
    const result = Code.computeSnapshotAverages_(
      [
        { date: '2026-11-05', amount: [500], category: '収入/給与', is_transfer: false },
        { date: '2026-11-06', amount: true, category: '収入/給与', is_transfer: false },
        { date: '2026-11-07', amount: 300, category: '収入/給与', is_transfer: false },
      ],
      '2026-11',
    );
    expect(result.incomeAverage).toBe(300);
    expect(result.monthCount).toBe(1);
  });

  it('does not throw when an entry date cannot be stringified', () => {
    const result = Code.computeSnapshotAverages_(
      [{ date: BAD, amount: 100, category: '収入/給与', is_transfer: false }],
      '2026-11',
    );
    expect(result).toEqual({ livingCostAverage: 0, incomeAverage: 0, monthCount: 0 });
  });

  it('classifies an unstringifiable category as a plain variable expense', () => {
    expect(Code.classifySnapshotExpenseType_({ category: BAD, is_transfer: false })).toBe('variable');
  });
});

describe('dashboard builders with degenerate (but in-contract) data', () => {
  it('headline: no comparison without two snapshots, zero base gives a null rate', () => {
    expect(Code.dashboardBuildHeadline_({ snapshots: [], currentNetAssetsYen: 123 })).toEqual(
      expect.objectContaining({ hasComparison: false, netAssetsYen: 123, diffYen: null }),
    );
    const headline = Code.dashboardBuildHeadline_({
      snapshots: [
        { month: '2026-10', netAssetsYen: 0 },
        { month: '2026-11', netAssetsYen: 500 },
      ],
    });
    expect(headline.diffYen).toBe(500);
    expect(headline.diffRatePct).toBeNull();
  });

  it('review and recent expenses over empty cash flow', () => {
    const review = Code.dashboardBuildCashFlowReview_([], '2026-11');
    expect(review.livingCostYen).toBe(0);
    expect(review.averageLivingCostYen).toBe(0);
    expect(review.categories).toEqual([]);
    expect(Code.dashboardBuildRecentExpenses_([])).toEqual(
      expect.objectContaining({ hasData: false, totalYen: 0, groups: [] }),
    );
  });

  it('asset daily change with no change keys has no data', () => {
    const daily = Code.dashboardBuildAssetDailyChange_({
      stocks: [{ '銘柄名': 'A', '評価額': '1000' }],
      funds: [],
    });
    expect(daily.hasData).toBe(false);
    expect(daily.totalDailyChangeYen).toBe(0);
    expect(daily.totalChangeRatePct).toBeNull();
  });

  it('fire progress over an empty portfolio stays finite or null', () => {
    const progress = Code.dashboardBuildFireProgress_({ portfolio: {}, baseParams: {} });
    expect(progress.totalAssetsYen).toBe(0);
    [progress.side, progress.full].forEach((run) => {
      expect(run.progressRate === null || Number.isFinite(run.progressRate)).toBe(true);
      expect(run.gapYen === null || Number.isFinite(run.gapYen)).toBe(true);
    });
  });

  it('asset goals over zero totals report a 0 progress rate', () => {
    const goals = Code.dashboardBuildAssetGoals_({
      portfolio: { totals: { assetsYen: 0, liabilitiesYen: 0 }, holdings: {}, cashFlow: [] },
      baseParams: { currentAge: 47, monthlyExpense: 0, monthlyIncome: 0 },
      startMonthKey: '2026-11',
    });
    expect(goals.total.progressRate).toBe(0);
    expect(goals.total.reached).toBe(false);
    expect(goals.net.progressRate).toBe(0);
  });
});
