import { describe, it, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as Code from '../src/Code.js';

// Property-based tests (fast-check) for the pure transforms:
// payload normalization, snapshot aggregation, region weights,
// month keys, the RSS slot, and the mfcf date parser.
//
// Generator domains: text fields are generated as grapheme-safe
// strings (real CSV / feed text carries no lone surrogates; the
// surrogate behaviour of the parsers is a string-domain question
// already pinned elsewhere in this fleet). JSON-domain fields
// additionally include an object whose toString is not callable
// ({"toString": []}, producible via JSON), a defect family found
// across this fleet: String() throws on it, so any boundary that
// stringifies a field without a guard dies on one such value.
const BAD = { toString: [] };

const jsonish = () =>
  fc.oneof(
    fc.jsonValue(),
    fc.constant(BAD),
    fc.constant(null),
    fc.integer({ min: -1000000, max: 1000000 }),
  );

const RUNS = { numRuns: 100 };

describe('dashboardNormalizePortfolio_ properties', () => {
  it('never throws and keeps every figure finite, for any JSON-shaped payload', () => {
    const rowArb = fc.record({
      category: jsonish(),
      amount_yen: jsonish(),
      percentage: jsonish(),
    });
    const apiArb = fc.record(
      {
        breakdown: fc.array(rowArb, { maxLength: 8 }),
        'breakdown-liability': fc.array(rowArb, { maxLength: 4 }),
        'total-liability': fc.array(fc.record({ total_yen: jsonish() }), { maxLength: 2 }),
        mfcf: fc.array(
          fc.record({
            date: jsonish(),
            amount: jsonish(),
            name: jsonish(),
            category: jsonish(),
            is_transfer: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        snapshots: fc.array(
          fc.record({ month: jsonish(), total_assets: jsonish(), net_assets: jsonish() }),
          { maxLength: 4 },
        ),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(apiArb, (api) => {
        const portfolio = Code.dashboardNormalizePortfolio_(api);
        expect(Number.isFinite(portfolio.totals.assetsYen)).toBe(true);
        expect(Number.isFinite(portfolio.totals.liabilitiesYen)).toBe(true);
        expect(Number.isFinite(portfolio.totals.netWorthYen)).toBe(true);
        portfolio.summary.assetsByClass.forEach((row) => {
          expect(typeof row.name).toBe('string');
          expect(Number.isFinite(row.amountYen)).toBe(true);
          expect(Number.isFinite(row.percentage)).toBe(true);
        });
        portfolio.cashFlow.forEach((row) => {
          expect(typeof row.date).toBe('string');
          expect(typeof row.name).toBe('string');
          expect(Number.isFinite(row.amount)).toBe(true);
        });
        portfolio.snapshots.forEach((row) => {
          expect(Number.isFinite(row.totalAssetsYen)).toBe(true);
        });
      }),
      RUNS,
    );
  });

  it('conserves the total: assetsYen is the sum of the breakdown amounts', () => {
    const rowArb = fc.record({
      category: fc.string(),
      amount: fc.integer({ min: -100000000, max: 100000000 }),
      asText: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 20 }), (rows) => {
        const breakdown = rows.map((row) => ({
          category: row.category,
          amount_yen: row.asText ? String(row.amount) : row.amount,
          percentage: '0',
        }));
        const portfolio = Code.dashboardNormalizePortfolio_({ breakdown });
        const expected = rows.reduce((sum, row) => sum + row.amount, 0);
        expect(portfolio.totals.assetsYen).toBe(expected);
        expect(portfolio.summary.assetsByClass).toHaveLength(rows.length);
        // Sum form (avoids any -0/+0 comparison trap): the parts
        // add back up to the reported total.
        const partsSum = portfolio.summary.assetsByClass.reduce(
          (sum, row) => sum + row.amountYen,
          0,
        );
        expect(partsSum - portfolio.totals.assetsYen).toBe(0);
      }),
      RUNS,
    );
  });

  it('dedupe: normalized cash flow has unique ids and never grows', () => {
    const rowArb = fc.record({
      date: fc.constantFrom('2026-01-05', '2026-01-06', '2026-02-01'),
      amount: fc.constantFrom(-100, -200, 300),
      name: fc.constantFrom('店A', '店B'),
      category: fc.constantFrom('食費/食費', '交通費'),
      is_transfer: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 12 }), (rows) => {
        const portfolio = Code.dashboardNormalizePortfolio_({ mfcf: rows });
        expect(portfolio.cashFlow.length).toBeLessThanOrEqual(rows.length);
        const ids = portfolio.cashFlow.map((row) => row.id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      RUNS,
    );
  });

  it('snapshots come out sorted by month and only with real month shapes', () => {
    const rowArb = fc.record({
      month: fc.constantFrom('2026-01', '2025-12', '2026-13', 'garbage', '2026-02', ''),
      total_assets: fc.integer({ min: 0, max: 100000000 }),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 10 }), (rows) => {
        const portfolio = Code.dashboardNormalizePortfolio_({ snapshots: rows });
        const months = portfolio.snapshots.map((row) => row.month);
        months.forEach((month) => expect(month).toMatch(/^\d{4}-\d{2}$/));
        const sorted = [...months].sort((a, b) => a.localeCompare(b));
        expect(months).toEqual(sorted);
      }),
      RUNS,
    );
  });
});

describe('computeSnapshotAverages_ properties', () => {
  it('matches the hand-computed totals for a generated month of entries', () => {
    const entryArb = fc.record({
      day: fc.integer({ min: 1, max: 28 }),
      amount: fc.integer({ min: -200000, max: 200000 }),
      category: fc.constantFrom('収入/給与', '食費/外食', '特別な支出/旅行'),
      is_transfer: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 30 }), (generated) => {
        const entries = generated.map((entry) => ({
          date: `2026-03-${String(entry.day).padStart(2, '0')}`,
          amount: entry.amount,
          category: entry.category,
          is_transfer: entry.is_transfer,
        }));
        const result = Code.computeSnapshotAverages_(entries, '2026-03');
        const active = entries.filter((entry) => !entry.is_transfer);
        if (active.length === 0) {
          expect(result).toEqual({ livingCostAverage: 0, incomeAverage: 0, monthCount: 0 });
          return;
        }
        const incomeTotal = active.reduce(
          (sum, entry) => sum + (entry.amount > 0 ? entry.amount : 0),
          0,
        );
        const livingTotal = active.reduce((sum, entry) => {
          if (entry.amount >= 0) return sum;
          // 食費/外食 is a variable living cost; 収入/ (negative)
          // and 特別な支出 are excluded by the classification.
          return entry.category === '食費/外食' ? sum + Math.abs(entry.amount) : sum;
        }, 0);
        expect(result.monthCount).toBe(1);
        expect(result.incomeAverage).toBe(Math.round(incomeTotal / 1));
        expect(result.livingCostAverage).toBe(Math.round(livingTotal / 1));
      }),
      RUNS,
    );
  });

  it('never throws and stays finite and non-negative for deformed entries', () => {
    const entryArb = fc.record({
      date: jsonish(),
      amount: jsonish(),
      category: jsonish(),
      is_transfer: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 10 }), (entries) => {
        const result = Code.computeSnapshotAverages_(entries, '2026-03');
        expect(Number.isFinite(result.incomeAverage)).toBe(true);
        expect(Number.isFinite(result.livingCostAverage)).toBe(true);
        expect(result.incomeAverage).toBeGreaterThanOrEqual(0);
        expect(result.livingCostAverage).toBeGreaterThanOrEqual(0);
        expect(result.monthCount).toBeGreaterThanOrEqual(0);
        expect(result.monthCount).toBeLessThanOrEqual(12);
      }),
      RUNS,
    );
  });
});

describe('region weight properties', () => {
  it('derived sets are complete and sum to 100', () => {
    const factsArb = fc
      .record({
        share: fc.integer({ min: 85, max: 95 }),
        acwiJapan: fc.integer({ min: 30, max: 65 }).map((v) => v / 10),
        acwiUs: fc.integer({ min: 50, max: 74 }),
        worldUs: fc.integer({ min: 50, max: 75 }),
      })
      .map(({ share, acwiJapan, acwiUs, worldUs }) => ({
        acwi: { us: acwiUs, japan: acwiJapan },
        world: { us: worldUs, japan: acwiJapan / (share / 100) },
      }));
    fc.assert(
      fc.property(factsArb, ({ acwi, world }) => {
        const sets = Code.deriveRegionWeightSets_(acwi, world);
        expect(sets).not.toBeNull();
        Object.values(sets).forEach((buckets) => {
          const sum = Object.values(buckets).reduce((acc, v) => acc + v, 0);
          expect(Math.abs(sum - 100)).toBeLessThan(0.01);
          Object.values(buckets).forEach((v) => {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
          });
        });
      }),
      RUNS,
    );
  });

  it('parsed weight rows yield only finite, non-negative bucket values', () => {
    const rowArb = fc.record({
      weight_set: fc.oneof(
        fc.constantFrom('acwi', 'developed', 'emerging', 'acwi_ex_japan', 'bogus'),
        fc.constant(BAD),
      ),
      bucket: fc.oneof(
        fc.constantFrom('japan', 'us', 'developed_other', 'emerging', 'other', 'bogus'),
        fc.constant(BAD),
      ),
      weight: fc.oneof(fc.string(), fc.integer({ min: -10, max: 200 }), fc.constant(BAD)),
      effective_date: fc.oneof(fc.string(), fc.constant(BAD)),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 12 }), (rows) => {
        const sets = Code.parseRegionWeightsRows_(rows);
        if (sets === null) return;
        Object.values(sets).forEach((set) => {
          ['japan', 'us', 'developed_other', 'emerging', 'other'].forEach((bucket) => {
            expect(Number.isFinite(set[bucket])).toBe(true);
            expect(set[bucket]).toBeGreaterThanOrEqual(0);
          });
          expect(typeof set.effective_date).toBe('string');
        });
      }),
      RUNS,
    );
  });
});

describe('month key and RSS slot properties', () => {
  it('expectedMfcfMonthKeys_ yields 13 consecutive real months, newest first', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date(2020, 0, 1), max: new Date(2035, 11, 31), noInvalidDate: true }), (date) => {
        const keys = Code.expectedMfcfMonthKeys_(date);
        expect(keys).toHaveLength(13);
        const indices = keys.map((key) => {
          expect(key).toMatch(/^\d{6}$/);
          const month = Number(key.slice(4, 6));
          expect(month).toBeGreaterThanOrEqual(1);
          expect(month).toBeLessThanOrEqual(12);
          return Number(key.slice(0, 4)) * 12 + (month - 1);
        });
        indices.forEach((value, i) => {
          if (i > 0) expect(indices[i - 1] - value).toBe(1);
        });
      }),
      RUNS,
    );
  });

  it('dashboardRssSlot_ is the most recent 06:20 JST at or before now', () => {
    const jstParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    fc.assert(
      fc.property(
        fc.integer({ min: Date.parse('2025-01-01T00:00:00Z'), max: Date.parse('2027-12-31T00:00:00Z') }),
        (nowMs) => {
          const slot = Code.dashboardRssSlot_(nowMs);
          expect(slot.atMs).toBeLessThanOrEqual(nowMs);
          expect(nowMs - slot.atMs).toBeLessThan(24 * 60 * 60 * 1000);
          const parts = {};
          jstParts.formatToParts(new Date(slot.atMs)).forEach((part) => {
            parts[part.type] = part.value;
          });
          expect(parts.hour).toBe('06');
          expect(parts.minute).toBe('20');
          expect(slot.dateKey).toBe(`${parts.year}-${parts.month}-${parts.day}`);
        },
      ),
      RUNS,
    );
  });
});

describe('dashboard builder properties over normalized rows', () => {
  const cashRowArb = fc.record({
    date: fc.constantFrom('2026-03-01', '2026-03-02', '2026-03-03'),
    amount: fc.integer({ min: -100000, max: -1 }),
    name: fc.string(),
    category: fc.constantFrom('食費/食料品', '日用品/日用品'),
    isTransfer: fc.constant(false),
  });

  it('recent expenses conserve the total across groups', () => {
    fc.assert(
      fc.property(fc.array(cashRowArb, { maxLength: 15 }), (cashFlow) => {
        const result = Code.dashboardBuildRecentExpenses_(cashFlow);
        const groupSum = result.groups.reduce((sum, group) => sum + group.totalYen, 0);
        expect(result.totalYen - groupSum).toBe(0);
        result.groups.forEach((group) => {
          const itemSum = group.items.reduce((sum, item) => sum + item.amountYen, 0);
          expect(group.totalYen - itemSum).toBe(0);
          expect(group.date >= result.fromDate && group.date <= result.latestDate).toBe(true);
        });
        const dates = result.groups.map((group) => group.date);
        expect(dates).toEqual([...dates].sort((a, b) => b.localeCompare(a)));
      }),
      RUNS,
    );
  });

  it('asset daily change conserves the total and ranks contributors', () => {
    const holdingArb = fc.record({
      name: fc.constantFrom('銘柄A', '銘柄B', '銘柄C', '銘柄D'),
      current: fc.integer({ min: 1000, max: 10000000 }),
      change: fc.integer({ min: -500000, max: 500000 }),
    });
    fc.assert(
      fc.property(fc.array(holdingArb, { maxLength: 10 }), (generated) => {
        const stocks = generated.map((row) => ({
          '銘柄名': row.name,
          '評価額': String(row.current),
          '前日比': String(row.change),
        }));
        const result = Code.dashboardBuildAssetDailyChange_({ stocks, funds: [] });
        const expectedTotal = generated.reduce((sum, row) => sum + row.change, 0);
        expect(result.totalDailyChangeYen).toBe(expectedTotal);
        expect(result.contributors.length).toBeLessThanOrEqual(3);
        const magnitudes = result.contributors.map((c) => Math.abs(c.changeYen));
        expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
        result.contributors.forEach((c) => {
          expect(c.changeRatePct === null || Number.isFinite(c.changeRatePct)).toBe(true);
        });
      }),
      RUNS,
    );
  });

  it('headline arithmetic: the diff is exact and the rate is null only for a zero base', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100000000, max: 100000000 }),
        fc.integer({ min: -100000000, max: 100000000 }),
        (previousYen, latestYen) => {
          const headline = Code.dashboardBuildHeadline_({
            snapshots: [
              { month: '2026-10', netAssetsYen: previousYen },
              { month: '2026-11', netAssetsYen: latestYen },
            ],
          });
          expect(headline.hasComparison).toBe(true);
          expect(headline.diffYen).toBe(latestYen - previousYen);
          if (previousYen === 0) {
            expect(headline.diffRatePct).toBeNull();
          } else {
            expect(headline.diffRatePct).toBeCloseTo(((latestYen - previousYen) / previousYen) * 100, 10);
          }
        },
      ),
      RUNS,
    );
  });
});

describe('mfcf date parsing property', () => {
  beforeAll(() => {
    global.Logger = { log: vi.fn() };
  });

  it('a shaped pubDate is kept exactly when the date exists, and dropped when it does not', () => {
    const dateArb = fc
      .record({
        year: fc.integer({ min: 2023, max: 2027 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 31 }),
      })
      .map(({ year, month, day }) => {
        const probe = new Date(Date.UTC(year, month - 1, day));
        const exists =
          probe.getUTCFullYear() === year &&
          probe.getUTCMonth() === month - 1 &&
          probe.getUTCDate() === day;
        const mm = String(month).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        return { text: `${year}-${mm}-${dd}`, exists };
      });
    fc.assert(
      fc.property(dateArb, ({ text, exists }) => {
        global.XmlService = {
          parse: vi.fn((xml) => {
            const itemXml = xml.match(/<item>[\s\S]*?<\/item>/)?.[0] || '';
            const title = itemXml.match(/<title>(.*?)<\/title>/)?.[1] || '';
            const pubDate = itemXml.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
            const description =
              itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
            const items = [
              {
                getChildText: (name) =>
                  name === 'title' ? title : name === 'pubDate' ? pubDate : description,
              },
            ];
            return {
              getRootElement: () => ({
                getChild: (name) => (name === 'channel' ? { getChildren: () => items } : null),
              }),
            };
          }),
        };
        const files = [
          {
            getName: () => 'mfcf.202602.xml',
            getBlob: () => ({
              getDataAsString: () =>
                `<rss version="2.0"><channel><item><title>02/12(木) -¥3,000 TEST</title>` +
                `<pubDate>${text}</pubDate>` +
                `<description><![CDATA[ amount: -¥3,000 category: C is_transfer: false ]]></description></item></channel></rss>`,
            }),
          },
        ];
        let index = 0;
        global.DriveApp = {
          getFolderById: vi.fn(() => ({
            getFiles: () => ({ hasNext: () => index < files.length, next: () => files[index++] }),
          })),
        };
        const entries = Code.getAllXmlDataEntries_();
        expect(entries).toHaveLength(1);
        expect(entries[0].date).toBe(exists ? text : '');
      }),
      { numRuns: 50 },
    );
  });
});

describe('buildDashboardRss_ properties', () => {
  it('escapes item text and emits exactly the well-formed items', () => {
    const itemArb = fc.record({
      title: fc.string(),
      guid: fc.string(),
      pubDate: fc.constant('Thu, 01 Jan 2026 00:00:00 GMT'),
      descriptionText: fc.string(),
    });
    fc.assert(
      fc.property(fc.array(itemArb, { maxLength: 5 }), (items) => {
        const xml = Code.buildDashboardRss_(items);
        const emitted = items.filter((item) => item.guid && item.pubDate);
        expect((xml.match(/<item>/g) || []).length).toBe(emitted.length);
        // No bare ampersand outside an entity anywhere in the document.
        expect(/&(?!(amp|lt|gt|quot|apos);)/.test(xml)).toBe(false);
        // Title slots carry no raw angle brackets from the input.
        const titles = [...xml.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => m[1]);
        titles.forEach((title) => {
          expect(title.includes('<')).toBe(false);
          expect(title.includes('>')).toBe(false);
        });
      }),
      RUNS,
    );
  });
});
