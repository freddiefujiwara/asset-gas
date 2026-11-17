const FOLDER_ID = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';

// Environment separation (staging): when the DATA_FOLDER_ID script
// property is set, all data and share-session files are read from that
// folder instead of the production folder above. When the property is
// unset, behavior is identical to production.
const dataFolderId_ = () => getScriptProperty_('DATA_FOLDER_ID') || FOLDER_ID;
const MAX_CACHE_DURATION_SECONDS = 21600;

const FORMAT_RULES = [
  {
    match: (typeName) => typeName === 'breakdown-liability' || typeName === 'breakdown',
    remove: ['timestamp', 'amount_text_num', 'percentage_text_num'],
  },
  {
    match: (typeName) => typeName.startsWith('details__liability'),
    remove: ['timestamp', 'detail_id', 'table_index', '残高_yen'],
  },
  {
    match: (typeName) => typeName === 'total-liability',
    remove: ['timestamp', 'total_text_num'],
  },
  {
    match: (typeName) => typeName === 'assetClassRatio',
    remove: ['timestamp'],
    transform: (item) => {
      if (Object.prototype.hasOwnProperty.call(item, 'y')) {
        item.amount_yen = item.y;
        delete item.y;
      }
    },
  },
  {
    match: (typeName) => typeName.startsWith('details__portfolio'),
    remove: ['timestamp', 'detail_id', 'table_index'],
  },
];

// --- Temporary share sessions (temporary access links) ---
// A logged-in owner can issue a URL token that grants read-only access for
// SHARE_TTL_SECONDS without a Google account. Sessions are stored as JSON
// records in a file kept in the same Drive folder as the data files
// (token hashes only, never raw tokens), which doubles as an audit log.
// The share file is never exposed as data.

const SHARE_FILE_NAME = 'asset-share-sessions.json';
// One month, so the owner can hand out a link well before it is needed.
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

const findSessionFile_ = fileName => {
  const folder = DriveApp.getFolderById(dataFolderId_());
  const files = folder.getFilesByName(fileName);
  return files.hasNext() ? files.next() : null;
};

const readSessionRecords_ = fileName => {
  const file = findSessionFile_(fileName);
  if (!file) {
    return [];
  }
  try {
    const records = JSON.parse(file.getBlob().getDataAsString());
    return Array.isArray(records) ? records : [];
  } catch (e) {
    // A corrupt session file is treated as having no sessions.
    return [];
  }
};

const writeSessionRecords_ = (fileName, records) => {
  const content = JSON.stringify(records);
  const file = findSessionFile_(fileName);
  if (file) {
    file.setContent(content);
    return;
  }
  DriveApp.getFolderById(dataFolderId_()).createFile(fileName, content, 'application/json');
};

const readShareRecords_ = () => readSessionRecords_(SHARE_FILE_NAME);

const writeShareRecords_ = records => writeSessionRecords_(SHARE_FILE_NAME, records);

const hashShareToken_ = token =>
  Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token))
    .map(byte => ((byte % 256) + 256) % 256)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

const revokeActiveSessions_ = (records, nowIso) => {
  records.forEach(record => {
    if (!record.revoked_at && record.expires_at && record.expires_at > nowIso) {
      record.revoked_at = nowIso;
    }
  });
};

const revokeActiveShareSessions_ = revokeActiveSessions_;

const issueSession_ = (fileName, tokenKey, { revokePrevious = true } = {}) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000).toISOString();
  const records = readSessionRecords_(fileName);
  if (revokePrevious) {
    revokeActiveSessions_(records, nowIso);
  }
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  records.push({
    token_hash: hashShareToken_(token),
    issued_at: nowIso,
    expires_at: expiresIso,
    revoked_at: '',
    access_count: 0,
    last_accessed_at: '',
  });
  writeSessionRecords_(fileName, records);
  return {
    [tokenKey]: token,
    issued_at: nowIso,
    expires_at: expiresIso,
    ttl_seconds: SHARE_TTL_SECONDS,
  };
};

const issueShareSession_ = () => issueSession_(SHARE_FILE_NAME, 'share_token');

const revokeShareSession_ = () => {
  const records = readShareRecords_();
  revokeActiveShareSessions_(records, new Date().toISOString());
  writeShareRecords_(records);
  return { revoked: true };
};

const validateSessionToken_ = (fileName, token) => {
  if (!token) {
    return null;
  }
  const hash = hashShareToken_(token);
  const records = readSessionRecords_(fileName);
  const nowIso = new Date().toISOString();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.token_hash !== hash) {
      continue;
    }
    if (record.revoked_at) {
      return null;
    }
    if (!record.expires_at || record.expires_at <= nowIso) {
      return null;
    }
    record.access_count = Number(record.access_count || 0) + 1;
    record.last_accessed_at = nowIso;
    writeSessionRecords_(fileName, records);
    return { expires_at: record.expires_at };
  }
  return null;
};

const validateShareToken_ = token => validateSessionToken_(SHARE_FILE_NAME, token);

// --- Owner sessions (long-lived sign-in) ---
// Google ID tokens expire after about an hour, which used to drop the
// owner back at the sign-in gate. After a Google sign-in the frontend
// exchanges the ID token for one of these 30-day owner sessions (same
// storage scheme as share sessions, separate file) and uses it for all
// later calls. Owner sessions coexist across devices: issuing a new
// one does not revoke the previous ones, and the frontend revokes its
// own session on logout.

const OWNER_FILE_NAME = 'asset-owner-sessions.json';

const issueOwnerSession_ = () =>
  issueSession_(OWNER_FILE_NAME, 'session_token', { revokePrevious: false });

const validateOwnerToken_ = token => validateSessionToken_(OWNER_FILE_NAME, token);

const revokeOwnerSession_ = token => {
  if (token) {
    const hash = hashShareToken_(token);
    const records = readSessionRecords_(OWNER_FILE_NAME);
    const nowIso = new Date().toISOString();
    let changed = false;
    records.forEach(record => {
      if (record.token_hash === hash && !record.revoked_at) {
        record.revoked_at = nowIso;
        changed = true;
      }
    });
    if (changed) {
      writeSessionRecords_(OWNER_FILE_NAME, records);
    }
  }
  return { revoked: true };
};

// Owner proof for owner-only actions: a valid Google ID token, or a
// live owner session token (the post-sign-in steady state).
const requireOwnerAuth_ = e => {
  const sessionToken = e?.parameter?.session_token;
  if (sessionToken && validateOwnerToken_(sessionToken)) {
    return;
  }
  verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
};

// --- Monthly snapshots ---
// Once a month, the headline figures (total assets, total liabilities,
// net assets, cash, risk assets, and the trailing-12-month averages of
// living cost and income) are recorded as one row in snapshots.csv in
// the same data folder. Because the file is a CSV in the data folder,
// the generic CSV pipeline already returns it in the API response under
// the "snapshots" key, so no response plumbing is needed. Rows are
// upserted by month: re-running for an existing month replaces its row
// instead of appending a duplicate.

const SNAPSHOT_FILE_NAME = 'snapshots.csv';
const SNAPSHOT_HEADERS = [
  'month',
  'total_assets',
  'total_liabilities',
  'net_assets',
  'cash',
  'risk_assets',
  'living_cost_12m_avg',
  'income_12m_avg',
];
// Category names in breakdown.csv are the ones Money Forward emits,
// which differ from the labels the client displays (the front end
// shows '現金・預金' for what the data calls '預金・現金'). The
// matching below is against the names in the data.
const SNAPSHOT_CASH_CATEGORY = '預金・現金';
// Risk assets are summed from exact category names, plus a prefix
// match for equities so that variants such as '株式(現物)' and a
// future '株式(信用)' are all included.
const SNAPSHOT_RISK_CATEGORIES = ['投資信託', '年金', '暗号資産'];
const SNAPSHOT_RISK_CATEGORY_PREFIX = '株式';

const isSnapshotRiskCategory_ = (category) =>
  category.startsWith(SNAPSHOT_RISK_CATEGORY_PREFIX)
  || SNAPSHOT_RISK_CATEGORIES.includes(category);

// Expense classification keywords. These mirror the client-side rules
// in freddiefujiwara/asset (src/domain/cashFlow/classifiers.js and
// constants.js) so the averages recorded here match the figures the
// cash-flow screen displays.
const SNAPSHOT_FIXED_CATEGORY_KEYWORDS = [
  '住宅/ローン返済',
  '住宅/管理費',
  '水道・光熱費',
  '教養・教育/学費',
  '保険/',
  '通信費/',
  '健康・医療/',
  '食費/食費',
  '食費/食料品',
  '日用品/',
  '衣服・美容/美容院・理髪',
];
const SNAPSHOT_EXCLUDE_CATEGORY_KEYWORDS = [
  'カード引き落とし',
  'ATM引き出し',
  '電子マネー',
  '使途不明金',
  '収入/',
];

const parseYenValue_ = (value) => {
  const number = Number(String(value ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(number) ? number : 0;
};

export function classifySnapshotExpenseType_(item) {
  const category = String(item?.category ?? '');

  if (item?.is_transfer) return 'exclude';
  if (category.startsWith('特別な支出')) return 'exclude';
  if (category.startsWith('現金')) return 'exclude';
  if (category.startsWith('カード')) return 'exclude';
  if (SNAPSHOT_EXCLUDE_CATEGORY_KEYWORDS.some((keyword) => category.includes(keyword))) {
    return 'exclude';
  }
  if (SNAPSHOT_FIXED_CATEGORY_KEYWORDS.some((keyword) => category.includes(keyword))) {
    return 'fixed';
  }
  return 'variable';
}

const snapshotMonthWindow_ = (monthKey) => {
  const [year, month] = String(monthKey).split('-').map((part) => parseInt(part, 10));
  const months = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(year, month - 1 - offset, 1));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${y}-${m}`);
  }
  return months;
};

/**
 * Trailing-12-month averages of income and living cost (fixed +
 * variable expenses), over the 12 months ending at monthKey
 * ('YYYY-MM'). Months without any non-transfer entries do not count
 * toward the divisor, mirroring the client-side aggregation.
 */
export function computeSnapshotAverages_(mfcfEntries, monthKey) {
  const windowMonths = new Set(snapshotMonthWindow_(monthKey));
  const monthly = {};

  (Array.isArray(mfcfEntries) ? mfcfEntries : []).forEach((item) => {
    if (item?.is_transfer) {
      return;
    }
    const month = String(item?.date || '').slice(0, 7);
    if (!windowMonths.has(month)) {
      return;
    }
    if (!monthly[month]) {
      monthly[month] = { income: 0, livingCost: 0 };
    }
    const amount = Number(item?.amount) || 0;
    if (amount > 0) {
      monthly[month].income += amount;
    } else if (amount < 0) {
      const type = classifySnapshotExpenseType_(item);
      if (type === 'fixed' || type === 'variable') {
        monthly[month].livingCost += Math.abs(amount);
      }
    }
  });

  const months = Object.keys(monthly);
  if (months.length === 0) {
    return { livingCostAverage: 0, incomeAverage: 0, monthCount: 0 };
  }

  const incomeTotal = months.reduce((sum, month) => sum + monthly[month].income, 0);
  const livingCostTotal = months.reduce((sum, month) => sum + monthly[month].livingCost, 0);

  return {
    livingCostAverage: Math.round(livingCostTotal / months.length),
    incomeAverage: Math.round(incomeTotal / months.length),
    monthCount: months.length,
  };
}

/**
 * Build one snapshot row for monthKey ('YYYY-MM') from the same data
 * the API serves: total assets is the sum of the breakdown rows (the
 * same total the balance sheet shows), and total liabilities is the
 * total-liability figure.
 */
export function computeSnapshotRow_(allData, mfcfEntries, monthKey) {
  const breakdown = Array.isArray(allData?.breakdown) ? allData.breakdown : [];
  let totalAssets = 0;
  let cash = 0;
  let riskAssets = 0;

  breakdown.forEach((row) => {
    const amount = parseYenValue_(row?.amount_yen);
    totalAssets += amount;
    const category = String(row?.category ?? '');
    if (category === SNAPSHOT_CASH_CATEGORY) {
      cash += amount;
    }
    if (isSnapshotRiskCategory_(category)) {
      riskAssets += amount;
    }
  });

  const liabilityRows = Array.isArray(allData?.['total-liability'])
    ? allData['total-liability']
    : [];
  const totalLiabilities = liabilityRows.length > 0
    ? parseYenValue_(liabilityRows[0]?.total_yen)
    : 0;

  const averages = computeSnapshotAverages_(mfcfEntries, monthKey);

  return {
    month: monthKey,
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    net_assets: totalAssets - totalLiabilities,
    cash,
    risk_assets: riskAssets,
    living_cost_12m_avg: averages.livingCostAverage,
    income_12m_avg: averages.incomeAverage,
  };
}

const findSnapshotFile_ = () => {
  const folder = DriveApp.getFolderById(dataFolderId_());
  const files = folder.getFilesByName(SNAPSHOT_FILE_NAME);
  return files.hasNext() ? files.next() : null;
};

const snapshotRowToCsvLine_ = (row) =>
  SNAPSHOT_HEADERS.map((header) => String(row[header] ?? '')).join(',');

/**
 * Insert the row into snapshots.csv, replacing the existing row for
 * the same month when present. Data lines are kept sorted by month.
 */
export function upsertSnapshotRow_(row) {
  const file = findSnapshotFile_();
  const existingLines = file
    ? file.getBlob().getDataAsString('UTF-8').split('\n').filter((line) => line.trim() !== '')
    : [];
  const dataLines = existingLines.filter(
    (line, index) => !(index === 0 && line.startsWith('month,')),
  );

  const monthPrefix = `${row.month},`;
  const existingIndex = dataLines.findIndex((line) => line.startsWith(monthPrefix));
  if (existingIndex >= 0) {
    dataLines[existingIndex] = snapshotRowToCsvLine_(row);
  } else {
    dataLines.push(snapshotRowToCsvLine_(row));
  }
  dataLines.sort();

  const content = `${[SNAPSHOT_HEADERS.join(','), ...dataLines].join('\n')}\n`;
  if (file) {
    file.setContent(content);
  } else {
    DriveApp.getFolderById(dataFolderId_()).createFile(SNAPSHOT_FILE_NAME, content, 'text/csv');
  }
  return row;
}

const formatMonthKey_ = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const normalizeSnapshotMonthKey_ = (monthKey) => {
  if (monthKey === undefined || monthKey === null || monthKey === '') {
    return formatMonthKey_(new Date());
  }
  const normalized = String(monthKey).trim();
  if (/^\d{4}-\d{2}$/.test(normalized)) {
    return normalized;
  }
  const compact = normalized.match(/^(\d{4})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}`;
  }
  throw new Error(`invalid month key: ${monthKey}`);
};

/**
 * Create (or refresh) the snapshot row for the given month. Accepts
 * 'YYYY-MM' or 'YYYYMM'; with no argument it targets the current
 * month, which is how the first row is created manually from the
 * Apps Script editor.
 */
export function createSnapshotForMonth(monthKey) {
  const targetMonth = normalizeSnapshotMonthKey_(monthKey);
  const allData = getAllCsvDataInFolder_();
  const mfcfEntries = getAllXmlDataEntries_();
  const row = computeSnapshotRow_(allData, mfcfEntries, targetMonth);
  upsertSnapshotRow_(row);
  return row;
}

/**
 * Monthly trigger entry point: records the previous month's snapshot.
 * Run on the 1st of each month, after the source data files have been
 * refreshed for the new month.
 */
export function createMonthlySnapshot() {
  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return createSnapshotForMonth(formatMonthKey_(previousMonth));
}

/**
 * One-time setup helper: run this once from the Apps Script editor to
 * (re)install the monthly time-driven trigger for createMonthlySnapshot
 * (1st of each month, 07:00-08:00, project time zone). Existing
 * triggers for the same handler are removed first.
 */
export function installMonthlySnapshotTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'createMonthlySnapshot')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  const trigger = ScriptApp.newTrigger('createMonthlySnapshot')
    .timeBased()
    .onMonthDay(1)
    .atHour(7)
    .create();

  return {
    installed: true,
    handler: 'createMonthlySnapshot',
    triggerId: trigger.getUniqueId(),
  };
}

export function preCacheAll() {
  const cache = CacheService.getScriptCache();

  // 古い月ごとのキャッシュキーを削除
  const oldMfcfKeysRaw = cache.get('mfcf');
  if (oldMfcfKeysRaw) {
    try {
      const oldKeys = JSON.parse(oldMfcfKeysRaw);
      if (Array.isArray(oldKeys)) {
        cache.removeAll(oldKeys);
      }
    } catch (e) {
      // パース失敗は無視
    }
  }

  const allEntries = getAllCsvDataEntries_();
  const allData = entriesToObject_(allEntries);
  const xmlDataByMonth = getAllXmlDataEntriesByMonth_();
  const mfcfKeys = xmlDataByMonth.map((item) => item.key);

  cache.removeAll(['0', 'mfcf']);
  cache.put('0', JSON.stringify(allData), MAX_CACHE_DURATION_SECONDS);
  cache.put('mfcf', JSON.stringify(mfcfKeys), MAX_CACHE_DURATION_SECONDS);

  xmlDataByMonth.forEach((item) => {
    cache.put(item.key, JSON.stringify(item.entries), MAX_CACHE_DURATION_SECONDS);
  });

  return {
    status: true,
    cachedKeys: ['0', 'mfcf', ...mfcfKeys],
  };
}

export function doGet(e) {
  try {
    const parameters = e?.parameter;

    let shareSession = null;

    const action = parameters?.action;

    // The dashboard RSS has its own token gate (it carries real
    // amounts) and sits outside the session / ID-token auth.
    if (action === 'dashboard_rss') {
      return serveDashboardRss_(parameters);
    }

    // Cache warming for the data-refresh job has its own token
    // gate too: the job runs outside any user session, so it
    // cannot use the ID-token auth that guards f=preCacheAll.
    if (action === 'warm_cache') {
      return serveWarmCache_(parameters);
    }

    if (action === 'exchange_session') {
      verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
      return createJsonResponse_(JSON.stringify(issueOwnerSession_()));
    }

    if (action === 'revoke_session') {
      return createJsonResponse_(
        JSON.stringify(revokeOwnerSession_(parameters?.session_token || '')),
      );
    }

    if (action === 'issue_share' || action === 'revoke_share') {
      requireOwnerAuth_(e);
      return createJsonResponse_(
        JSON.stringify(action === 'issue_share' ? issueShareSession_() : revokeShareSession_()),
      );
    }

    if (parameters?.session_token) {
      if (!validateOwnerToken_(parameters.session_token)) {
        throw new Error('session expired or invalid');
      }
    } else if (parameters?.share_token) {
      shareSession = validateShareToken_(parameters.share_token);
      if (!shareSession) {
        throw new Error('share session expired or invalid');
      }
    } else {
      verifyGoogleIdTokenOrThrow_(extractIdToken_(e));
    }

    // Cache warming rebuilds the whole aggregated cache from Drive;
    // it sits behind the same authentication as the data itself so an
    // anonymous caller cannot burn the script quota with it. (The
    // preCacheAll function itself stays callable from the editor and
    // from time-driven triggers, which run as the owner.)
    if (parameters?.f === 'preCacheAll') {
      return createJsonResponse_(JSON.stringify(preCacheAll()));
    }

    if (isNoCacheMode_()) {
      return createLiveDataResponse_(shareSession);
    }

    const cachedData = getAggregatedCachedData_();
    if (cachedData !== null) {
      return createJsonResponse_(
        JSON.stringify(withShareFlag_(withNoCacheFlag_(cachedData, false), shareSession)),
      );
    }

    return createLiveDataResponse_(shareSession);
  } catch (error) {
    const message = error?.message || 'unauthorized';
    const status = message === 'forbidden email' ? 403 : 401;
    return createJsonResponse_(JSON.stringify({ status, error: message }));
  }
}


function createLiveDataResponse_(shareSession) {
  const allData = getAllCsvDataInFolder_();
  return createJsonResponse_(
    JSON.stringify(
      withShareFlag_(
        withNoCacheFlag_(attachMfcfEntries_(allData, getAllXmlDataEntries_()), true),
        shareSession,
      ),
    ),
  );
}

function getAggregatedCachedData_() {
  const cachedCsvData = getCacheValue_('0');
  const cachedMfcfKeysRaw = getCacheValue_('mfcf');

  if (cachedCsvData === null || cachedMfcfKeysRaw === null) {
    return null;
  }

  try {
    const allData = JSON.parse(cachedCsvData);
    const mfcfKeys = JSON.parse(cachedMfcfKeysRaw);

    if (!Array.isArray(mfcfKeys)) {
      return null;
    }

    let allXmlEntries = [];

    for (const key of mfcfKeys) {
      const monthDataRaw = getCacheValue_(key);
      if (monthDataRaw === null) {
        return null;
      }
      allXmlEntries = allXmlEntries.concat(JSON.parse(monthDataRaw));
    }

    return attachMfcfEntries_(allData, allXmlEntries);
  } catch (e) {
    // パース失敗などは無視してライブデータ取得へ
    return null;
  }
}

function attachMfcfEntries_(allData, mfcfEntries) {
  return {
    ...allData,
    mfcf: mfcfEntries,
    weights: buildRegionWeights_(allData ? allData[REGION_WEIGHTS_KEY] : null),
  };
}

/**
 * CSV文字列をJSON配列に変換する補助関数
 */
export function parseCsv_(csvString) {
  const values = Utilities.parseCsv(csvString);

  if (values.length < 2) {
    return [];
  }

  const [headers, ...rows] = values;

  return rows.map((row) => mapRowToObject_(headers, row));
}

/**
 * tの値に基づいてデータを整形する
 */
export function applyFormattingRules(data, typeName) {
  if (!Array.isArray(data)) {
    return data;
  }

  const activeRule = FORMAT_RULES.find((rule) => rule.match(typeName));

  return data.map((item) => {
    const clonedItem = { ...item };

    if (!activeRule) {
      return clonedItem;
    }

    removeKeys_(clonedItem, activeRule.remove);

    if (activeRule.transform) {
      activeRule.transform(clonedItem);
    }

    return clonedItem;
  });
}

function getScriptCache_() {
  if (typeof CacheService === 'undefined' || !CacheService.getScriptCache) {
    return null;
  }

  return CacheService.getScriptCache();
}

function getCacheValue_(key) {
  const cache = getScriptCache_();

  if (!cache || !cache.get) {
    return null;
  }

  const value = cache.get(key);
  return value === null ? null : value;
}

function createJsonResponse_(jsonString) {
  return ContentService
    .createTextOutput(jsonString)
    .setMimeType(ContentService.MimeType.JSON);
}

function getCsvFilesIterator_() {
  const folder = DriveApp.getFolderById(dataFolderId_());
  logDebug_(`CSV scan start. folderId=${dataFolderId_()}`);
  return folder.getFiles();
}

function getAllCsvDataInFolder_() {
  const allEntries = getAllCsvDataEntries_();
  return entriesToObject_(allEntries);
}

function getAllCsvDataEntries_() {
  const files = getCsvFilesIterator_();
  const entries = [];
  let scannedCount = 0;
  let csvFileCount = 0;
  let skippedNonCsvCount = 0;

  while (files.hasNext()) {
    const file = files.next();
    scannedCount += 1;
    const fileName = file.getName();
    if (!/\.csv$/i.test(fileName)) {
      skippedNonCsvCount += 1;
      continue;
    }

    csvFileCount += 1;
    const typeName = removeCsvExtension_(fileName);
    const csvContent = file.getBlob().getDataAsString('UTF-8');
    const parsedRows = parseCsv_(csvContent);
    logDebug_(`CSV read. file=${fileName} type=${typeName} bytes=${csvContent.length} rows=${parsedRows.length}`);
    entries.push({
      typeName,
      data: applyFormattingRules(parsedRows, typeName),
    });
  }

  logDebug_(`CSV scan done. scanned=${scannedCount} csv=${csvFileCount} skipped_non_csv=${skippedNonCsvCount} keys=${entries.length}`);

  return entries;
}

function entriesToObject_(entries) {
  return entries.reduce((acc, entry) => {
    acc[entry.typeName] = entry.data;
    return acc;
  }, {});
}

function removeCsvExtension_(fileName) {
  return fileName.replace(/\.csv$/i, '');
}

/**
 * mfcf.YYYYMM.xmlファイルを読み込み、月ごとのキーとデータのリストを返す
 */
function getAllXmlDataEntriesByMonth_() {
  const folder = DriveApp.getFolderById(dataFolderId_());
  const files = folder.getFiles();
  const xmlFiles = [];
  const regex = /^mfcf\.(\d{6})\.xml$/;
  let scannedCount = 0;
  let skippedCount = 0;
  logDebug_(`XML scan start. folderId=${dataFolderId_()}`);

  while (files.hasNext()) {
    const file = files.next();
    scannedCount += 1;
    const fileName = file.getName();
    const match = fileName.match(regex);
    if (match) {
      logDebug_(`XML target found. file=${fileName} yyyymm=${match[1]}`);
      xmlFiles.push({
        file: file,
        yyyymm: match[1],
      });
    } else {
      skippedCount += 1;
    }
  }

  logDebug_(`XML scan done. scanned=${scannedCount} target=${xmlFiles.length} skipped=${skippedCount}`);

  // YYYYMMが大きい順（新しい順）にソート
  xmlFiles.sort((a, b) => parseInt(b.yyyymm, 10) - parseInt(a.yyyymm, 10));

  return xmlFiles.map((item) => {
    try {
      const xmlContent = item.file.getBlob().getDataAsString('UTF-8');
      const entries = parseMfcfXml_(xmlContent, item.yyyymm);
      logDebug_(`XML parsed. key=mfcf.${item.yyyymm} bytes=${xmlContent.length} entries=${entries.length}`);
      return {
        key: `mfcf.${item.yyyymm}`,
        entries,
      };
    } catch (e) {
      Logger.log(`Failed to process file mfcf.${item.yyyymm}.xml: ${e.message}`);
      return {
        key: `mfcf.${item.yyyymm}`,
        entries: [],
      };
    }
  });
}

/**
 * mfcf.YYYYMM.xmlファイルを読み込み、全データを結合して返す
 */
export function getAllXmlDataEntries_() {
  const dataByMonth = getAllXmlDataEntriesByMonth_();
  const allEntries = dataByMonth.reduce((acc, item) => acc.concat(item.entries), []);
  logDebug_(`XML merge done. monthKeys=${dataByMonth.length} totalEntries=${allEntries.length}`);
  return allEntries;
}

/**
 * XML(RSS 2.0)をパースしてオブジェクトの配列に変換する
 */
function parseMfcfXml_(xmlContent, defaultYear) {
  logDebug_(`XML parse start. defaultYear=${defaultYear} bytes=${String(xmlContent || '').length}`);
  const document = XmlService.parse(xmlContent);
  const root = document.getRootElement();
  const channel = root.getChild('channel');
  if (!channel) {
    logDebug_('XML parse no channel. returning empty entries.');
    return [];
  }

  const items = channel.getChildren('item');
  logDebug_(`XML parse item count=${items.length}`);

  const parsed = items.map((item) => {
    const title = item.getChildText('title') || '';
    const pubDate = item.getChildText('pubDate') || '';
    const description = item.getChildText('description') || '';

    // titleから金額と名前を抽出
    // 形式例: "02/12(木) -¥3,000 DF.トウキユウカ-ド"
    const titleMatch = title.match(/^\d{2}\/\d{2}\(.+?\)\s+([+-]?¥[\d,]+)\s+(.+)$/);
    let amountText = '0';
    let name = title;
    if (titleMatch) {
      amountText = titleMatch[1];
      name = titleMatch[2];
    }

    const amount = parseInt(amountText.replace(/[¥,]/g, ''), 10) || 0;

    // descriptionからcategoryとis_transferを抽出
    // 形式例: " date: 02/12(木) amount: -¥3,000 category: 食費/その他食費 is_transfer: false "
    const categoryMatch = description.match(/category:\s*(.*?)\s+is_transfer:/);
    const category = categoryMatch ? categoryMatch[1].trim() : '';

    const isTransferMatch = description.match(/is_transfer:\s*(true|false)/);
    const is_transfer = isTransferMatch ? isTransferMatch[1] === 'true' : false;

    return {
      date: formatDate_(pickDateText_(description, title, pubDate), defaultYear),
      amount,
      currency: 'JPY',
      name,
      category,
      is_transfer,
    };
  });

  logDebug_(`XML parse done. parsedEntries=${parsed.length}`);
  return parsed;
}

function logDebug_(message) {
  if (typeof Logger === 'undefined' || !Logger.log) {
    return;
  }

  Logger.log(`[DEBUG] ${message}`);
}


function pickDateText_(description, title, pubDate) {
  const normalizedPubDate = String(pubDate || '').trim();

  // pubDate自体が YYYY/MM/DD or YYYY-MM-DD の場合はそれを優先する
  if (/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/.test(normalizedPubDate)) {
    return normalizedPubDate;
  }

  // 明細の取引日(date:)を優先する
  const descriptionDateMatch = String(description || '').match(/date:\s*((?:\d{4}[\/-])?\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{1,2})?)/);
  if (descriptionDateMatch) {
    return descriptionDateMatch[1];
  }

  // title先頭の MM/DD などをフォールバックで使う
  const titleDateMatch = String(title || '').match(/^(\d{1,4}[\/-]\d{1,2}(?:[\/-]\d{1,2})?)/);
  if (titleDateMatch) {
    return titleDateMatch[1];
  }

  // 最後の手段としてpubDateを使う
  return normalizedPubDate;
}

/**
 * pubDateをYYYY-MM-DD形式に変換する
 */
function formatDate_(pubDate, defaultYear) {
  if (!pubDate) return '';

  const normalizedPubDate = String(pubDate).trim();
  if (!normalizedPubDate) return '';

  const fallbackYear = extractYearFromFileTag_(defaultYear);

  // YYYY/MM/DD 形式または YYYY-MM-DD 形式は、明示年を優先して採用する
  const explicitYmdMatch = normalizedPubDate.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (explicitYmdMatch) {
    const yyyy = explicitYmdMatch[1];
    const mm = explicitYmdMatch[2].padStart(2, '0');
    const dd = explicitYmdMatch[3].padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  // MM/DD 形式で年が含まれていない場合、defaultYear を付加する
  const mmddMatch = normalizedPubDate.match(/(\d{1,2})\/(\d{1,2})/);
  if (mmddMatch && !/\d{4}/.test(normalizedPubDate)) {
    const year = fallbackYear || new Date().getFullYear();
    const mm = mmddMatch[1].padStart(2, '0');
    const dd = mmddMatch[2].padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  }

  try {
    const d = new Date(normalizedPubDate);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (e) {
    return '';
  }
}

function extractYearFromFileTag_(fileTag) {
  if (!fileTag) return '';

  const normalized = String(fileTag);
  const yyyymmMatch = normalized.match(/^(\d{4})\d{2}$/);
  if (yyyymmMatch) {
    return yyyymmMatch[1];
  }

  const yyyyMatch = normalized.match(/^(\d{4})$/);
  if (yyyyMatch) {
    return yyyyMatch[1];
  }

  return '';
}

function mapRowToObject_(headers, row) {
  return headers.reduce((acc, header, index) => {
    acc[header] = row[index];
    return acc;
  }, {});
}

function removeKeys_(object, keys = []) {
  keys.forEach((key) => {
    delete object[key];
  });
}

function getScriptProperties_() {
  if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
    return null;
  }

  return PropertiesService.getScriptProperties();
}

function getScriptProperty_(key) {
  const properties = getScriptProperties_();
  if (!properties || !properties.getProperty) {
    return '';
  }

  return properties.getProperty(key) || '';
}

function isNoCacheMode_() {
  return getScriptProperty_('NO_CACHE') === 'true';
}

function withNoCacheFlag_(payload, noCache) {
  return {
    ...payload,
    no_cache: noCache,
  };
}

function withShareFlag_(payload, shareSession) {
  if (!shareSession) {
    return payload;
  }

  return {
    ...payload,
    _share: { expires_at: shareSession.expires_at },
  };
}

function extractIdToken_(event) {
  const headers = event?.headers || {};
  const auth = headers.Authorization || headers.authorization || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1];

  return event?.parameter?.id_token || '';
}

function getAllowedEmails_() {
  return getScriptProperty_('AVAILABLE_GMAILS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function verifyGoogleIdTokenOrThrow_(idToken) {
  if (!idToken) {
    throw new Error('missing id token');
  }

  const oauthClientId = getScriptProperty_('GOOGLE_OAUTH_CLIENT_ID');
  if (!oauthClientId) {
    throw new Error('missing GOOGLE_OAUTH_CLIENT_ID');
  }

  const response = UrlFetchApp.fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { muteHttpExceptions: true },
  );

  if (response.getResponseCode() !== 200) {
    throw new Error('token verification failed');
  }

  const payload = JSON.parse(response.getContentText());

  const validIssuer = payload.iss === 'accounts.google.com'
    || payload.iss === 'https://accounts.google.com';
  if (!validIssuer) {
    throw new Error('invalid iss');
  }

  if (payload.aud !== oauthClientId) {
    throw new Error('invalid aud');
  }

  const expSeconds = Number(payload.exp || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expSeconds) || expSeconds <= nowSeconds) {
    throw new Error('token expired');
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) {
    throw new Error('email not verified');
  }

  const email = String(payload.email || '').toLowerCase();
  if (!email) {
    throw new Error('missing email');
  }

  const allowed = getAllowedEmails_();
  if (!allowed.includes(email)) {
    throw new Error('forbidden email');
  }

  return { email, sub: payload.sub };
}

// --- Asset dashboard RSS (action=dashboard_rss) ---
// GET /exec?action=dashboard_rss&token=<redacted> returns the
// /asset top page (dashboard) as an RSS 2.0 feed for /reader,
// mirroring the /social performance highlights feed
// (action=perf_rss in social-gas): one item per day, delivered
// at 06:20 (Asia/Tokyo). The item is computed on the fly from
// the same data the JSON API serves, with the same calculations
// the front end runs for its home screen (the builders below
// are ports of freddiefujiwara/asset's home view models and
// FIRE engine), so the figures match the screen. The guid is
// the slot's date, so re-fetching never duplicates an item.
// The items carry real amounts, so the feed is token-gated by
// the DASHBOARD_RSS_TOKEN script property and fails closed:
// while the property is unset, or the token mismatches, every
// request is refused.

const DASHBOARD_RSS_TOKEN_PROPERTY = 'DASHBOARD_RSS_TOKEN';
const DASHBOARD_RSS_TIME = '06:20:00';
const DASHBOARD_RSS_CHANNEL = {
  title: '資産ダッシュボード',
  link: 'https://freddiefujiwara.com/asset/',
  description: '資産トップページのダイジェスト（毎朝6:20）',
};
const DASHBOARD_RSS_DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_RSS_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
// The character budget of one item's summary, kept in step
// with the /social highlights feed: /reader's article cards
// clamp the summary to three lines.
const DASHBOARD_RSS_SUMMARY_CHARS = 110;

// The JST calendar date (YYYY-MM-DD) containing the instant.
function dashboardRssJstDateKey_(ms) {
  const shifted = new Date(ms + DASHBOARD_RSS_JST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + month + '-' + day;
}

// The current delivery slot: today's 06:20 JST once it has
// passed, otherwise yesterday's (today's item is not generated
// yet). Returns { dateKey, atMs }.
export function dashboardRssSlot_(nowMs) {
  const todayKey = dashboardRssJstDateKey_(nowMs);
  const todayAtMs = Date.parse(todayKey + 'T' + DASHBOARD_RSS_TIME + '+09:00');
  if (todayAtMs <= nowMs) {
    return { dateKey: todayKey, atMs: todayAtMs };
  }
  const yesterdayKey = dashboardRssJstDateKey_(
    Date.parse(todayKey + 'T00:00:00+09:00') - DASHBOARD_RSS_DAY_MS,
  );
  return {
    dateKey: yesterdayKey,
    atMs: Date.parse(yesterdayKey + 'T' + DASHBOARD_RSS_TIME + '+09:00'),
  };
}

function escapeDashboardXmlText_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createDashboardXmlResponse_(xml) {
  return ContentService.createTextOutput(xml).setMimeType(ContentService.MimeType.XML);
}

// Builds the RSS 2.0 document from dashboard items (at most
// the latest slot's item). Titles, guids and descriptions are
// escaped here.
export function buildDashboardRss_(items) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '<channel>',
    '<title>' + escapeDashboardXmlText_(DASHBOARD_RSS_CHANNEL.title) + '</title>',
    '<link>' + escapeDashboardXmlText_(DASHBOARD_RSS_CHANNEL.link) + '</link>',
    '<description>' + escapeDashboardXmlText_(DASHBOARD_RSS_CHANNEL.description) + '</description>',
  ];
  (items || []).forEach((item) => {
    if (!item || !item.guid || !item.pubDate) {
      return;
    }
    lines.push(
      '<item>',
      '<title>' + escapeDashboardXmlText_(item.title || '') + '</title>',
      '<link>' + escapeDashboardXmlText_(DASHBOARD_RSS_CHANNEL.link) + '</link>',
      '<guid isPermaLink="false">' + escapeDashboardXmlText_(item.guid) + '</guid>',
      '<pubDate>' + item.pubDate + '</pubDate>',
      '<description>' + escapeDashboardXmlText_(item.descriptionText || '') + '</description>',
      '</item>',
    );
  });
  lines.push('</channel>', '</rss>');
  return lines.join('\n');
}

// Serves action=dashboard_rss. The token check comes first and
// fails closed: an unset DASHBOARD_RSS_TOKEN refuses every
// request. The data is the same payload the JSON API serves
// (the aggregated cache when warm, live Drive reads otherwise).
function serveDashboardRss_(parameter) {
  const expected = getScriptProperty_(DASHBOARD_RSS_TOKEN_PROPERTY);
  if (!expected || !parameter.token || parameter.token !== expected) {
    return createJsonResponse_(JSON.stringify({ ok: false, status: 403, error: 'invalid token' }));
  }
  try {
    const cachedData = getAggregatedCachedData_();
    const allData = cachedData !== null
      ? cachedData
      : attachMfcfEntries_(getAllCsvDataInFolder_(), getAllXmlDataEntries_());
    const portfolio = dashboardNormalizePortfolio_(allData);
    const item = buildDashboardRssItem_(portfolio, Date.now());
    return createDashboardXmlResponse_(buildDashboardRss_(item ? [item] : []));
  } catch (err) {
    return createJsonResponse_(
      JSON.stringify({
        ok: false,
        status: 502,
        error: 'feed unavailable: ' + (err && err.message ? err.message : String(err)),
      }),
    );
  }
}

// --- Cache warming endpoint (action=warm_cache) ---
// GET /exec?action=warm_cache&token=<redacted> rebuilds the
// aggregated cache by running preCacheAll(). The data-refresh
// job on the home server (playwright-mf.sh, daily 06:10) calls
// it right after exporting fresh data files, so the first
// reader of the day never pays the rebuild. The job holds no
// user session, so — like the dashboard RSS — the endpoint
// sits outside the session / ID-token auth and is gated by
// its own script property, WARM_CACHE_TOKEN, failing closed.
// (f=preCacheAll behind the ID-token auth is unchanged, and
// preCacheAll stays callable from the editor and triggers.)

const WARM_CACHE_TOKEN_PROPERTY = 'WARM_CACHE_TOKEN';

// Serves action=warm_cache. The token check comes first and
// fails closed: an unset WARM_CACHE_TOKEN refuses every
// request. On success it returns preCacheAll()'s result
// ({ status: true, cachedKeys: [...] }) as JSON.
function serveWarmCache_(parameter) {
  const expected = getScriptProperty_(WARM_CACHE_TOKEN_PROPERTY);
  if (!expected || !parameter.token || parameter.token !== expected) {
    return createJsonResponse_(JSON.stringify({ ok: false, status: 403, error: 'invalid token' }));
  }
  return createJsonResponse_(JSON.stringify(preCacheAll()));
}

// --- Region weights (look-through regional allocation) ---
// The front end renders an "effective regional allocation" pie:
// index funds are split into region buckets (japan / us /
// developed_other / emerging / other) by weight sets instead of
// counting as one opaque "global" block. The weights live in
// region-weights.csv in the data folder (columns: weight_set,
// bucket, weight, effective_date) and reach the client as the
// structured "weights" key that attachMfcfEntries_ adds to every
// data payload. Because the CSV rides the generic folder scan,
// the raw rows also appear under the "region-weights" key; the
// structured form is the contract the front end consumes.
//
// updateRegionWeights (monthly, on the 2nd) refreshes the CSV
// from the iShares MSCI ACWI ETF holdings file — a public proxy
// for the MSCI ACWI country composition. The fetch is strictly
// validated (the bucket total must land within 95-105% before
// normalization); on any failure the current weights are kept
// untouched, so a blocked or changed source can never corrupt
// the allocation. The "developed" set (MSCI Kokusai / World ex
// Japan) is derived from the same country data by dropping
// Japan and the emerging markets and renormalizing.

const REGION_WEIGHTS_FILE_NAME = 'region-weights.csv';
const REGION_WEIGHTS_KEY = 'region-weights';
const REGION_WEIGHT_SETS = ['acwi', 'developed', 'emerging'];
const REGION_BUCKETS = ['japan', 'us', 'developed_other', 'emerging', 'other'];
const REGION_WEIGHTS_SOURCE_URL =
  'https://www.ishares.com/us/products/239696/ishares-msci-acwi-etf/1467271812596.ajax?tab=all&fileType=csv';

// Seed weights, used until region-weights.csv exists and as the
// buildRegionWeights_ fallback. Derived from the official MSCI
// factsheets as of 2026-10-30 (ACWI: US 64.63, Japan 5.08,
// UK 3.12, Canada 3.06, Taiwan 3.23, Other 20.88; World: US
// 72.77, Japan 5.72). The ACWI emerging share (11.19) is
// 100 - 64.63 / 72.77 * 100 (the developed share implied by the
// two factsheets; Japan cross-checks: 5.72 * 0.8881 = 5.08).
// The developed set renormalizes MSCI World ex Japan to 100.
const REGION_WEIGHTS_SEED_DATE = '2026-10-30';
const REGION_WEIGHTS_SEED = {
  acwi: { japan: 5.08, us: 64.63, developed_other: 19.1, emerging: 11.19, other: 0 },
  developed: { japan: 0, us: 77.19, developed_other: 22.81, emerging: 0, other: 0 },
  emerging: { japan: 0, us: 0, developed_other: 0, emerging: 100, other: 0 },
};

// MSCI market classification used to bucket iShares "Location"
// values. Developed markets other than the US and Japan fold
// into developed_other; anything unrecognized is ignored by the
// fetch parser and only shows up in the residual "other" share.
const REGION_DM_COUNTRIES = [
  'Australia', 'Austria', 'Belgium', 'Canada', 'Denmark', 'Finland',
  'France', 'Germany', 'Hong Kong', 'Ireland', 'Israel', 'Italy',
  'Netherlands', 'New Zealand', 'Norway', 'Portugal', 'Singapore',
  'Spain', 'Sweden', 'Switzerland', 'United Kingdom',
];
const REGION_EM_COUNTRIES = [
  'Brazil', 'Chile', 'China', 'Colombia', 'Czech Republic', 'Egypt',
  'Greece', 'Hungary', 'India', 'Indonesia', 'Korea', 'Kuwait',
  'Malaysia', 'Mexico', 'Peru', 'Philippines', 'Poland', 'Qatar',
  'Saudi Arabia', 'South Africa', 'South Korea', 'Taiwan', 'Thailand',
  'Turkey', 'United Arab Emirates',
];

/**
 * Reshape region-weights.csv rows into the structured weights
 * object the API returns:
 *   { acwi: { japan, us, developed_other, emerging, other,
 *             effective_date }, developed: {...}, ... }
 * Returns null when no usable row is present.
 */
export function parseRegionWeightsRows_(rows) {
  if (!Array.isArray(rows)) {
    return null;
  }
  const sets = {};
  rows.forEach((row) => {
    const setName = String(row?.weight_set ?? '').trim();
    const bucket = String(row?.bucket ?? '').trim();
    const weight = Number(row?.weight);
    if (!REGION_WEIGHT_SETS.includes(setName) || !REGION_BUCKETS.includes(bucket)) {
      return;
    }
    if (!Number.isFinite(weight) || weight < 0) {
      return;
    }
    if (!sets[setName]) {
      sets[setName] = { effective_date: String(row?.effective_date ?? '').trim() };
    }
    sets[setName][bucket] = weight;
  });
  const names = Object.keys(sets);
  if (!names.length) {
    return null;
  }
  names.forEach((name) => {
    REGION_BUCKETS.forEach((bucket) => {
      if (typeof sets[name][bucket] !== 'number') {
        sets[name][bucket] = 0;
      }
    });
  });
  return sets;
}

const regionWeightsSeedSets_ = () =>
  Object.fromEntries(
    Object.entries(REGION_WEIGHTS_SEED).map(([name, buckets]) => [
      name,
      { ...buckets, effective_date: REGION_WEIGHTS_SEED_DATE },
    ]),
  );

/**
 * The weights contract for API payloads: the CSV rows when they
 * parse, the embedded seed otherwise, so the key is always
 * present and the front end rarely needs its own fallback.
 */
export function buildRegionWeights_(rows) {
  return parseRegionWeightsRows_(rows) ?? regionWeightsSeedSets_();
}

const regionWeightsRows_ = (sets, effectiveDate) => {
  const rows = [];
  REGION_WEIGHT_SETS.forEach((setName) => {
    const set = sets[setName];
    if (!set) {
      return;
    }
    REGION_BUCKETS.forEach((bucket) => {
      rows.push({
        weight_set: setName,
        bucket,
        weight: set[bucket] ?? 0,
        effective_date: effectiveDate,
      });
    });
  });
  return rows;
};

const regionWeightsCsvText_ = (rows) =>
  [
    'weight_set,bucket,weight,effective_date',
    ...rows.map((row) => `${row.weight_set},${row.bucket},${row.weight},${row.effective_date}`),
  ].join('\n') + '\n';

const findRegionWeightsFile_ = () => {
  const folder = DriveApp.getFolderById(dataFolderId_());
  const files = folder.getFilesByName(REGION_WEIGHTS_FILE_NAME);
  return files.hasNext() ? files.next() : null;
};

const writeRegionWeightsCsv_ = (sets, effectiveDate) => {
  const content = regionWeightsCsvText_(regionWeightsRows_(sets, effectiveDate));
  const file = findRegionWeightsFile_();
  if (file) {
    file.setContent(content);
  } else {
    DriveApp.getFolderById(dataFolderId_()).createFile(
      REGION_WEIGHTS_FILE_NAME,
      content,
      'text/csv',
    );
  }
  return content;
};

/**
 * One-time setup helper: create region-weights.csv from the
 * embedded seed when it does not exist yet. Run once from the
 * Apps Script editor for each project (production / staging).
 * Existing files are left untouched.
 */
export function ensureRegionWeightsFile() {
  if (findRegionWeightsFile_()) {
    return { created: false, reason: 'region-weights.csv already exists' };
  }
  writeRegionWeightsCsv_(regionWeightsSeedSets_(), REGION_WEIGHTS_SEED_DATE);
  return { created: true, effectiveDate: REGION_WEIGHTS_SEED_DATE };
}

/**
 * Parse the iShares holdings CSV into per-country weights
 * ({ 'United States': 64.6, Japan: 5.1, ... }). The file has a
 * preamble above the holdings table, so the header row (first
 * cell "Ticker", with "Location" and "Weight (%)" columns) is
 * located first. Cash / derivative rows are excluded. Returns
 * null when the content does not look like the holdings file
 * (for example a bot-check HTML page) or nothing usable parses.
 */
export function parseAcwiHoldingsCsv_(csvText) {
  if (typeof csvText !== 'string' || !csvText.includes('Location')) {
    return null;
  }
  const table = Utilities.parseCsv(csvText);
  const headerIndex = table.findIndex(
    (row) => row[0] === 'Ticker' && row.includes('Location') && row.includes('Weight (%)'),
  );
  if (headerIndex < 0) {
    return null;
  }
  const header = table[headerIndex];
  const locationIdx = header.indexOf('Location');
  const weightIdx = header.indexOf('Weight (%)');
  const assetClassIdx = header.indexOf('Asset Class');
  const sectorIdx = header.indexOf('Sector');

  const countryWeights = {};
  let total = 0;
  table.slice(headerIndex + 1).forEach((row) => {
    const assetClass = assetClassIdx >= 0 ? String(row[assetClassIdx] ?? '') : '';
    const sector = sectorIdx >= 0 ? String(row[sectorIdx] ?? '') : '';
    if (/cash/i.test(assetClass) || /cash/i.test(sector)) {
      return;
    }
    const location = String(row[locationIdx] ?? '').trim();
    const weight = Number(row[weightIdx]);
    if (!location || !Number.isFinite(weight) || weight <= 0) {
      return;
    }
    countryWeights[location] = (countryWeights[location] ?? 0) + weight;
    total += weight;
  });

  if (!countryWeights['United States'] || total <= 0) {
    return null;
  }
  return countryWeights;
}

const normalizeRegionBuckets_ = (buckets) => {
  const total = REGION_BUCKETS.reduce((sum, bucket) => sum + (buckets[bucket] ?? 0), 0);
  if (!(total > 0)) {
    return null;
  }
  const normalized = {};
  REGION_BUCKETS.forEach((bucket) => {
    normalized[bucket] = Math.round(((buckets[bucket] ?? 0) / total) * 100 * 100) / 100;
  });
  // Absorb the rounding residue into the largest bucket so the
  // set sums to exactly 100.
  const roundedTotal = REGION_BUCKETS.reduce((sum, bucket) => sum + normalized[bucket], 0);
  const largest = REGION_BUCKETS.reduce((a, b) => (normalized[a] >= normalized[b] ? a : b));
  normalized[largest] = Math.round((normalized[largest] + (100 - roundedTotal)) * 100) / 100;
  return normalized;
};

/**
 * Aggregate per-country weights into the region weight sets.
 * The grand total must land within 95-105% (the holdings file
 * carries a small cash / unclassified residue); anything else
 * returns null so the caller keeps the current weights.
 */
export function aggregateRegionWeights_(countryWeights) {
  if (!countryWeights || typeof countryWeights !== 'object') {
    return null;
  }
  const sumOf = (countries) =>
    countries.reduce((sum, country) => sum + (countryWeights[country] ?? 0), 0);
  const japan = countryWeights['Japan'] ?? 0;
  const us = countryWeights['United States'] ?? 0;
  const developedOther = sumOf(REGION_DM_COUNTRIES);
  const emerging = sumOf(REGION_EM_COUNTRIES);
  const total = Object.values(countryWeights).reduce((sum, w) => sum + (Number(w) || 0), 0);
  if (total < 95 || total > 105 || us <= 0) {
    return null;
  }
  const acwi = normalizeRegionBuckets_({
    japan,
    us,
    developed_other: developedOther,
    emerging,
    other: Math.max(0, total - japan - us - developedOther - emerging),
  });
  const developedBase = us + developedOther;
  if (!acwi || developedBase <= 0) {
    return null;
  }
  const developed = normalizeRegionBuckets_({
    japan: 0,
    us: (us / developedBase) * 100,
    developed_other: (developedOther / developedBase) * 100,
    emerging: 0,
    other: 0,
  });
  if (!developed) {
    return null;
  }
  return {
    acwi,
    developed,
    emerging: { japan: 0, us: 0, developed_other: 0, emerging: 100, other: 0 },
  };
}

/**
 * Fetch the ACWI country composition from the iShares holdings
 * file. Returns the parsed per-country weights, or null when
 * the source cannot be fetched or parsed (bot protection,
 * format change, network error) — never throws.
 */
export function fetchAcwiCountryWeights_() {
  try {
    const response = UrlFetchApp.fetch(REGION_WEIGHTS_SOURCE_URL, {
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (response.getResponseCode() !== 200) {
      return null;
    }
    return parseAcwiHoldingsCsv_(response.getContentText());
  } catch (e) {
    return null;
  }
}

const formatDateKey_ = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;

/**
 * Monthly batch entry point (trigger: 2nd of each month,
 * 07:00-08:00 JST): refresh region-weights.csv from the latest
 * published ACWI country composition. When the source cannot
 * be fetched or the numbers fail validation, the current CSV
 * is kept and the result reports updated: false — the weights
 * simply stay one month older, which the front end surfaces
 * through effective_date.
 */
export function updateRegionWeights() {
  const countryWeights = fetchAcwiCountryWeights_();
  if (!countryWeights) {
    return { updated: false, reason: 'source fetch or parse failed; keeping current weights' };
  }
  const sets = aggregateRegionWeights_(countryWeights);
  if (!sets) {
    return { updated: false, reason: 'country weights failed validation; keeping current weights' };
  }
  const effectiveDate = formatDateKey_(new Date());
  writeRegionWeightsCsv_(sets, effectiveDate);
  try {
    preCacheAll();
  } catch (e) {
    // The CSV is already written; the cache picks it up on the
    // next warm-up or TTL expiry.
  }
  return { updated: true, effectiveDate, sets };
}

/**
 * One-time setup helper: run this once from the Apps Script
 * editor to (re)install the monthly time-driven trigger for
 * updateRegionWeights (2nd of each month, 07:00-08:00, project
 * time zone). Existing triggers for the same handler are
 * removed first. Note the trigger itself must be installed
 * from the editor — merges and CI deploys do not create it.
 */
export function installRegionWeightsTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'updateRegionWeights')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  const trigger = ScriptApp.newTrigger('updateRegionWeights')
    .timeBased()
    .onMonthDay(2)
    .atHour(7)
    .create();

  return {
    installed: true,
    handler: 'updateRegionWeights',
    triggerId: trigger.getUniqueId(),
  };
}

// --- Formatting / parsing helpers (ports of the front end's
// format / parse / signed layers) ---

// An integer with thousands separators, sign kept.
const dashboardFormatInt_ = (value) =>
  String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const dashboardFormatYen_ = (value) => '¥' + dashboardFormatInt_(dashboardToNumber_(value));

const dashboardFormatSignedYen_ = (value) => {
  const amount = dashboardToNumber_(value);
  const sign = amount > 0 ? '+' : amount < 0 ? '-' : '±';
  return sign + '¥' + dashboardFormatInt_(Math.abs(amount));
};

// Signed percent with the given digits; '' when not computable.
const dashboardFormatSignedPercent_ = (value, digits = 1) => {
  if (value === null || value === undefined) {
    return '';
  }
  const sign = value > 0 ? '+' : value < 0 ? '-' : '±';
  return sign + Math.abs(value).toFixed(digits) + '%';
};

// Change rate (%) = change / base * 100; null when the base
// is 0 (not computable).
const dashboardDiffRatePct_ = (diffYen, baseYen) => {
  if (baseYen === 0) {
    return null;
  }
  return (diffYen / baseYen) * 100;
};

const dashboardHasAccountingNegativeMarker_ = (raw) => {
  const normalized = String(raw ?? '').trim();
  return (normalized.startsWith('(') && normalized.endsWith(')')) || /^[▲△]/.test(normalized);
};

// Port of the front end's toNumber (parse layer).
const dashboardToNumber_ = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const isNegative = dashboardHasAccountingNegativeMarker_(value);
  const normalized = value
    .replace(/[￥¥,\s]/g, '')
    .replace(/円/g, '')
    .replace(/[()▲△]/g, '')
    .replace(/[^0-9.+-]/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return isNegative ? -Math.abs(parsed) : parsed;
};

// Port of the front end's toPercent (parse layer).
const dashboardToPercent_ = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value !== 'string') {
    return 0;
  }
  const isNegative = dashboardHasAccountingNegativeMarker_(value);
  const normalized = value.replace(/[%()▲△]/g, '').trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return isNegative ? -Math.abs(parsed) : parsed;
};

// --- Portfolio normalization (port of the front end's
// normalizePortfolio): converts the raw API payload (CSV rows
// keyed by file name, plus the mfcf entries) into the domain
// shape the home builders consume. ---

const dashboardAsArray_ = (value) => (Array.isArray(value) ? value : []);

const dashboardNormalizeText_ = (value, fallback = '') => String(value ?? fallback).trim();

// Pension rows whose 評価損益 is missing get it derived from
// 現在価値 and 評価損益率, as on the front end.
const dashboardWithDerivedPensionProfit_ = (row) => {
  if (!row || typeof row !== 'object') {
    return row;
  }
  if (row['評価損益'] != null) {
    return row;
  }
  const currentValue = dashboardToNumber_(row['現在価値']);
  const ratePercent = dashboardToPercent_(row['評価損益率']);
  const denominator = 100 + ratePercent;
  if (!Number.isFinite(currentValue) || !Number.isFinite(ratePercent) || denominator === 0) {
    return row;
  }
  const profitYen = Math.round((currentValue * ratePercent) / denominator);
  return { ...row, 評価損益: String(profitYen) };
};

const dashboardNormalizeSnapshots_ = (rows) =>
  dashboardAsArray_(rows)
    .map((row) => ({
      month: dashboardNormalizeText_(row?.month),
      totalAssetsYen: dashboardToNumber_(row?.total_assets),
      totalLiabilitiesYen: dashboardToNumber_(row?.total_liabilities),
      netAssetsYen: dashboardToNumber_(row?.net_assets),
      cashYen: dashboardToNumber_(row?.cash),
      riskAssetsYen: dashboardToNumber_(row?.risk_assets),
      livingCost12mAvgYen: dashboardToNumber_(row?.living_cost_12m_avg),
      income12mAvgYen: dashboardToNumber_(row?.income_12m_avg),
    }))
    .filter((row) => /^\d{4}-\d{2}$/.test(row.month))
    .sort((a, b) => a.month.localeCompare(b.month));

const dashboardNormalizeCashFlowRows_ = (rows) => {
  const normalized = dashboardAsArray_(rows).map((item) => ({
    date: dashboardNormalizeText_(item?.date),
    amount: dashboardToNumber_(item?.amount),
    currency: dashboardNormalizeText_(item?.currency, 'JPY') || 'JPY',
    name: dashboardNormalizeText_(item?.name),
    category: dashboardNormalizeText_(item?.category),
    isTransfer: Boolean(item?.is_transfer),
  }));

  const seen = new Set();
  return normalized.flatMap((item) => {
    const rowKey = `${item.date}::${item.amount}::${item.currency}::${item.name}::${item.category}::${item.isTransfer ? 1 : 0}`;
    if (seen.has(rowKey)) {
      return [];
    }
    seen.add(rowKey);
    return [{ id: rowKey, ...item }];
  });
};

export function dashboardNormalizePortfolio_(api) {
  const safeApi = api ?? {};

  const assetsByClass = dashboardAsArray_(safeApi.breakdown).map((item) => ({
    name: String(item?.category ?? ''),
    amountYen: dashboardToNumber_(item?.amount_yen),
    percentage: dashboardToPercent_(item?.percentage),
  }));

  const liabilitiesByCategory = dashboardAsArray_(safeApi['breakdown-liability']).map((item) => ({
    category: String(item?.category ?? ''),
    amountYen: dashboardToNumber_(item?.amount_yen),
    percentage: dashboardToPercent_(item?.percentage),
  }));

  const assetsYen = assetsByClass.reduce((sum, item) => sum + item.amountYen, 0);
  const liabilitiesYen = dashboardToNumber_(safeApi['total-liability']?.[0]?.total_yen);

  return {
    totals: {
      assetsYen,
      liabilitiesYen,
      netWorthYen: assetsYen - liabilitiesYen,
    },
    summary: {
      assetsByClass,
      liabilitiesByCategory,
    },
    holdings: {
      cashLike: dashboardAsArray_(safeApi.details__portfolio_det_depo__t0),
      stocks: dashboardAsArray_(safeApi.details__portfolio_det_eq__t0),
      funds: dashboardAsArray_(safeApi.details__portfolio_det_mf__t0),
      pensions: dashboardAsArray_(safeApi.details__portfolio_det_pns__t0).map((row) =>
        dashboardWithDerivedPensionProfit_(row),
      ),
      points: dashboardAsArray_(safeApi.details__portfolio_det_po__t0),
      liabilitiesDetail: dashboardAsArray_(safeApi['details__liability_det__t0-liability']),
    },
    cashFlow: dashboardNormalizeCashFlowRows_(safeApi.mfcf),
    snapshots: dashboardNormalizeSnapshots_(safeApi.snapshots),
  };
}

// --- Cash-flow classification (port of the front end's
// cashFlow/classifiers + constants) ---

const DASHBOARD_CASH_FLOW_FIXED_KEYWORDS = [
  '住宅/ローン返済',
  '住宅/管理費',
  '水道・光熱費',
  '教養・教育/学費',
  '保険/',
  '通信費/',
  '健康・医療/',
  '食費/食費',
  '食費/食料品',
  '日用品/',
  '衣服・美容/美容院・理髪',
];
const DASHBOARD_CASH_FLOW_EXCLUDE_KEYWORDS = [
  'カード引き落とし',
  'ATM引き出し',
  '電子マネー',
  '使途不明金',
  '収入/',
];

// 'fixed' | 'variable' | 'exclude', as the front end's
// getExpenseType.
const dashboardGetExpenseType_ = (categoryOrItem) => {
  const isObj = categoryOrItem && typeof categoryOrItem === 'object';
  const isTransfer = isObj ? categoryOrItem.isTransfer : false;
  const rawCategory = isObj ? categoryOrItem.category : categoryOrItem;
  const category = String(rawCategory ?? '');

  if (isTransfer) return 'exclude';
  if (category.startsWith('特別な支出')) return 'exclude';
  if (category.startsWith('現金')) return 'exclude';
  if (category.startsWith('カード')) return 'exclude';
  if (DASHBOARD_CASH_FLOW_EXCLUDE_KEYWORDS.some((k) => category.includes(k))) return 'exclude';
  if (DASHBOARD_CASH_FLOW_FIXED_KEYWORDS.some((k) => category.includes(k))) return 'fixed';
  return 'variable';
};

const dashboardIsSpecialExpense_ = (item) => {
  if (!item || item.isTransfer || Number(item.amount) >= 0) return false;
  return String(item.category ?? '').startsWith('特別な支出');
};

const dashboardGetMonthKey_ = (item) => {
  const month = item.date?.substring(0, 7) || '';
  return month.length === 7 ? month : '';
};

// --- Home card judgments (ports of the front end's
// domain/home/cards) ---

const DASHBOARD_CARD_STATUS = { OK: 'ok', ATTENTION: 'attention' };
const DASHBOARD_MONTHLY_INVESTMENT_STANDARD_SELF_YEN = 323000;
const DASHBOARD_INVESTMENT_TOLERANCE_RATE = 0.05;
const DASHBOARD_LIVING_COST_ATTENTION_RATE = 1.1;
const DASHBOARD_FRESHNESS_STALE_DAYS = 3;
const DASHBOARD_INVESTMENT_NAME_KEYWORDS = ['投信積立', '確定拠出年金', 'カクテイキヨシユツネンキン'];

const dashboardFormatMonthKey_ = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const dashboardShiftMonthKey_ = (monthKey, delta) => {
  const [year, month] = String(monthKey).split('-').map(Number);
  const shifted = new Date(year, month - 1 + delta, 1);
  return dashboardFormatMonthKey_(shifted);
};

const dashboardIsInvestmentExecution_ = (item) => {
  if (!item || Number(item.amount) >= 0) return false;
  const name = String(item.name ?? '');
  return DASHBOARD_INVESTMENT_NAME_KEYWORDS.some((keyword) => name.includes(keyword));
};

const dashboardSumInvestmentExecutions_ = (cashFlow, monthKey) =>
  (cashFlow ?? [])
    .filter((item) => dashboardGetMonthKey_(item) === monthKey && dashboardIsInvestmentExecution_(item))
    .reduce((sum, item) => sum + Math.abs(Number(item.amount)), 0);

// Investment card: last month judged against the owner's own
// monthly standard (323,000 yen), with a -5% tolerance.
const dashboardBuildInvestmentCard_ = (cashFlow, currentMonthKey) => {
  const lastMonth = dashboardShiftMonthKey_(currentMonthKey, -1);
  const lastAmount = dashboardSumInvestmentExecutions_(cashFlow, lastMonth);
  const standard = DASHBOARD_MONTHLY_INVESTMENT_STANDARD_SELF_YEN;
  const status =
    lastAmount >= standard * (1 - DASHBOARD_INVESTMENT_TOLERANCE_RATE)
      ? DASHBOARD_CARD_STATUS.OK
      : DASHBOARD_CARD_STATUS.ATTENTION;
  return {
    status,
    standardYen: standard,
    lastMonth: { month: lastMonth, amountYen: lastAmount },
    currentMonth: {
      month: currentMonthKey,
      amountYen: dashboardSumInvestmentExecutions_(cashFlow, currentMonthKey),
    },
  };
};

// Freshness card: the newest cash-flow date stands in for the
// import time; 3+ days old means the import has likely stopped.
const dashboardBuildFreshnessCard_ = (cashFlow, todayKey) => {
  let latestDate = '';
  (cashFlow ?? []).forEach((item) => {
    if (item.date && item.date > latestDate) latestDate = item.date;
  });
  if (!latestDate) {
    return { status: DASHBOARD_CARD_STATUS.ATTENTION, latestDate: '', ageDays: null };
  }
  const ageDays = Math.round(
    (Date.parse(todayKey + 'T00:00:00Z') - Date.parse(latestDate + 'T00:00:00Z')) / DASHBOARD_RSS_DAY_MS,
  );
  return {
    status: ageDays >= DASHBOARD_FRESHNESS_STALE_DAYS
      ? DASHBOARD_CARD_STATUS.ATTENTION
      : DASHBOARD_CARD_STATUS.OK,
    latestDate,
    ageDays,
  };
};

const dashboardListSpecialExpenses_ = (cashFlow, monthKey) =>
  (cashFlow ?? [])
    .filter(
      (item) =>
        dashboardGetMonthKey_(item) === monthKey &&
        !item.isTransfer &&
        Number(item.amount) < 0 &&
        String(item.category ?? '').startsWith('特別な支出'),
    )
    .map((item) => ({
      date: item.date,
      name: item.name,
      category: item.category,
      amountYen: Math.abs(Number(item.amount)),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

// --- Cash-flow review (port of the front end's
// domain/cashFlow/review): last month's living cost by large
// category against the trailing-12-month average. ---

const DASHBOARD_REVIEW_CATEGORY_LIMIT = 3;
const DASHBOARD_REVIEW_TOP_EXPENSE_LIMIT = 3;

const dashboardLivingCostByLargeCategory_ = (cashFlow, monthKey) => {
  const byLargeCategory = {};
  let total = 0;
  (cashFlow ?? []).forEach((item) => {
    if (dashboardGetMonthKey_(item) !== monthKey) return;
    if (item.isTransfer || Number(item.amount) >= 0) return;
    if (dashboardGetExpenseType_(item) === 'exclude') return;
    const absAmount = Math.abs(Number(item.amount));
    total += absAmount;
    const largeCategory = String(item.category ?? '未分類').split('/')[0] || '未分類';
    byLargeCategory[largeCategory] = (byLargeCategory[largeCategory] ?? 0) + absAmount;
  });
  return { total, byLargeCategory };
};

const dashboardTopExpensesByLargeCategory_ = (cashFlow, monthKey) => {
  const byLargeCategory = new Map();
  (cashFlow ?? []).forEach((item) => {
    if (dashboardGetMonthKey_(item) !== monthKey) return;
    if (item.isTransfer || Number(item.amount) >= 0) return;
    if (dashboardGetExpenseType_(item) === 'exclude') return;
    const largeCategory = String(item.category ?? '未分類').split('/')[0] || '未分類';
    const entries = byLargeCategory.get(largeCategory) ?? [];
    entries.push({
      date: item.date,
      name: item.name,
      amountYen: Math.abs(Number(item.amount)),
    });
    byLargeCategory.set(largeCategory, entries);
  });
  byLargeCategory.forEach((entries, label) => {
    entries.sort((a, b) => b.amountYen - a.amountYen || b.date.localeCompare(a.date));
    byLargeCategory.set(label, entries.slice(0, DASHBOARD_REVIEW_TOP_EXPENSE_LIMIT));
  });
  return byLargeCategory;
};

export function dashboardBuildCashFlowReview_(cashFlow, currentMonthKey) {
  const targetMonth = dashboardShiftMonthKey_(currentMonthKey, -1);
  const target = dashboardLivingCostByLargeCategory_(cashFlow, targetMonth);

  let windowTotal = 0;
  const windowByCategory = {};
  for (let i = 1; i <= 12; i++) {
    const monthResult = dashboardLivingCostByLargeCategory_(
      cashFlow,
      dashboardShiftMonthKey_(currentMonthKey, -i),
    );
    windowTotal += monthResult.total;
    Object.entries(monthResult.byLargeCategory).forEach(([label, value]) => {
      windowByCategory[label] = (windowByCategory[label] ?? 0) + value;
    });
  }
  const average = windowTotal / 12;
  const topExpenses = dashboardTopExpensesByLargeCategory_(cashFlow, targetMonth);

  const labels = new Set([...Object.keys(windowByCategory), ...Object.keys(target.byLargeCategory)]);
  const categories = Array.from(labels)
    .map((label) => {
      const monthYen = target.byLargeCategory[label] ?? 0;
      const averageYen = (windowByCategory[label] ?? 0) / 12;
      return {
        label,
        monthYen,
        averageYen: Math.round(averageYen),
        excessYen: Math.round(monthYen - averageYen),
        ratioPct: averageYen > 0 ? Math.round((monthYen / averageYen - 1) * 100) : null,
        topExpenses: topExpenses.get(label) ?? [],
      };
    })
    .filter(
      (category) =>
        category.monthYen > 0 &&
        category.monthYen > category.averageYen * DASHBOARD_LIVING_COST_ATTENTION_RATE,
    )
    .sort((a, b) => b.excessYen - a.excessYen)
    .slice(0, DASHBOARD_REVIEW_CATEGORY_LIMIT);

  const specialItems = dashboardListSpecialExpenses_(cashFlow, targetMonth);

  return {
    month: targetMonth,
    livingCostYen: target.total,
    averageLivingCostYen: Math.round(average),
    livingCostOverAverage:
      average > 0 && target.total > average * DASHBOARD_LIVING_COST_ATTENTION_RATE,
    categories,
    special: {
      totalYen: specialItems.reduce((sum, item) => sum + item.amountYen, 0),
      items: specialItems,
    },
  };
}

// --- Attention list (port of the front end's
// domain/home/attention): priority-ordered, at most 3 items. ---

const DASHBOARD_ATTENTION_ITEM_LIMIT = 3;
const DASHBOARD_ATTENTION_SPECIAL_EXPENSE_YEN = 50000;
const DASHBOARD_ATTENTION_PRIORITY = {
  freshness: 10,
  investment: 20,
  category: 30,
  livingCost: 40,
  special: 50,
};

export function dashboardBuildAttentionItems_({ investmentCard, freshnessCard, review } = {}) {
  const candidates = [];

  if (freshnessCard?.status === DASHBOARD_CARD_STATUS.ATTENTION) {
    candidates.push({
      id: 'freshness',
      kind: 'freshness',
      priority: DASHBOARD_ATTENTION_PRIORITY.freshness,
      latestDate: freshnessCard.latestDate,
      ageDays: freshnessCard.ageDays,
      linkTo: null,
    });
  }

  if (investmentCard?.status === DASHBOARD_CARD_STATUS.ATTENTION) {
    candidates.push({
      id: 'investment',
      kind: 'investment',
      priority: DASHBOARD_ATTENTION_PRIORITY.investment,
      month: investmentCard.lastMonth.month,
      amountYen: investmentCard.lastMonth.amountYen,
      standardYen: investmentCard.standardYen,
      linkTo: '/cash-flow',
    });
  }

  const categories = Array.isArray(review?.categories) ? review.categories : [];
  categories.forEach((category) => {
    candidates.push({
      id: `category-${category.label}`,
      kind: 'category',
      priority: DASHBOARD_ATTENTION_PRIORITY.category,
      label: category.label,
      monthYen: category.monthYen,
      averageYen: category.averageYen,
      excessYen: category.excessYen,
      ratioPct: category.ratioPct,
      topExpenses: Array.isArray(category.topExpenses) ? category.topExpenses : [],
      linkTo: null,
    });
  });

  if (review?.livingCostOverAverage) {
    candidates.push({
      id: 'living-cost',
      kind: 'living-cost',
      priority: DASHBOARD_ATTENTION_PRIORITY.livingCost,
      month: review.month,
      amountYen: review.livingCostYen,
      averageYen: review.averageLivingCostYen,
      linkTo: '/cash-flow',
    });
  }

  const specialItems = Array.isArray(review?.special?.items) ? review.special.items : [];
  if (specialItems.length) {
    const largest = specialItems.reduce((max, item) =>
      item.amountYen > max.amountYen ? item : max,
    );
    if (largest.amountYen >= DASHBOARD_ATTENTION_SPECIAL_EXPENSE_YEN) {
      candidates.push({
        id: 'special',
        kind: 'special',
        priority: DASHBOARD_ATTENTION_PRIORITY.special,
        month: review.month,
        name: largest.name,
        date: largest.date,
        amountYen: largest.amountYen,
        linkTo: '/cash-flow',
      });
    }
  }

  const sorted = [...candidates].sort((a, b) => a.priority - b.priority);
  return {
    items: sorted.slice(0, DASHBOARD_ATTENTION_ITEM_LIMIT),
    totalCount: sorted.length,
  };
}

// --- Asset daily change (port of the front end's
// domain/home/assetDaily): the day-over-day move of the stock
// and fund holdings, with the largest contributors. Only the
// same-day move keys are used; the cumulative 評価損益 is
// never treated as a daily move. ---

const DASHBOARD_DAILY_CHANGE_KEYS = ['前日比', '前日からの値動き', '前日損益', '前日比損益', '当日損益'];
const DASHBOARD_ASSET_DAILY_CONTRIBUTOR_LIMIT = 3;

const dashboardStrictDailyChangeYen_ = (row) => {
  if (!row || typeof row !== 'object') {
    return null;
  }
  for (const key of DASHBOARD_DAILY_CHANGE_KEYS) {
    if (key in row) {
      return dashboardToNumber_(row[key]);
    }
  }
  return null;
};

export function dashboardBuildAssetDailyChange_(holdings) {
  const holdingRows = (key) => {
    const rows = holdings?.[key];
    return Array.isArray(rows) ? rows : [];
  };
  const rows = [...holdingRows('stocks'), ...holdingRows('funds')];
  const byName = new Map();
  let totalDailyChangeYen = 0;
  let totalCurrentYen = 0;
  let totalRateKnown = true;
  let rowsWithData = 0;

  rows.forEach((row) => {
    const changeYen = dashboardStrictDailyChangeYen_(row);
    if (changeYen == null) return;
    rowsWithData += 1;
    totalDailyChangeYen += changeYen;
    const currentYen = '評価額' in row ? dashboardToNumber_(row['評価額']) : null;
    if (currentYen == null) {
      totalRateKnown = false;
    } else {
      totalCurrentYen += currentYen;
    }
    const name = row['銘柄名'] || row['銘柄コード'] || '名称未設定';
    const entry = byName.get(name) ?? { changeYen: 0, currentYen: 0, rateKnown: true };
    entry.changeYen += changeYen;
    if (currentYen == null) {
      entry.rateKnown = false;
    } else {
      entry.currentYen += currentYen;
    }
    byName.set(name, entry);
  });

  const contributors = Array.from(byName, ([name, entry]) => ({
    name,
    changeYen: entry.changeYen,
    changeRatePct: entry.rateKnown
      ? dashboardDiffRatePct_(entry.changeYen, entry.currentYen - entry.changeYen)
      : null,
  }))
    .sort((a, b) => Math.abs(b.changeYen) - Math.abs(a.changeYen))
    .slice(0, DASHBOARD_ASSET_DAILY_CONTRIBUTOR_LIMIT);

  return {
    hasData: rowsWithData > 0,
    totalDailyChangeYen,
    totalChangeRatePct:
      rowsWithData > 0 && totalRateKnown
        ? dashboardDiffRatePct_(totalDailyChangeYen, totalCurrentYen - totalDailyChangeYen)
        : null,
    contributors,
    rowsWithData,
    rowsTotal: rows.length,
  };
}

// The current risk-asset total shown next to the daily move:
// stocks + funds + pensions, valued at 評価額 (or 現在価値),
// as the front end's riskAssetSummary computes it.
const dashboardRiskAssetsTotalYen_ = (holdings) => {
  const safe = holdings ?? {};
  const rows = [
    ...(Array.isArray(safe.stocks) ? safe.stocks : []),
    ...(Array.isArray(safe.funds) ? safe.funds : []),
    ...(Array.isArray(safe.pensions) ? safe.pensions : []),
  ];
  return rows.reduce(
    (sum, row) => sum + (dashboardToNumber_(row?.['評価額']) || dashboardToNumber_(row?.['現在価値'])),
    0,
  );
};

// --- Recent expenses (port of the front end's
// domain/home/recentExpenses): the 3 days ending at the
// newest cash-flow date, grouped by day. Transfers, income
// and double-counted rows (card settlements, cash
// withdrawals, e-money charges) are excluded; special
// expenses are included. ---

const DASHBOARD_RECENT_EXPENSE_DAYS = 3;

const dashboardIsRecentSpending_ = (item) => {
  if (!item || item.isTransfer || Number(item.amount) >= 0) return false;
  return dashboardGetExpenseType_(item) !== 'exclude' || dashboardIsSpecialExpense_(item);
};

const dashboardShiftDateKey_ = (dateKey, deltaDays) => {
  const baseMs = Date.parse(dateKey + 'T00:00:00Z');
  const shifted = new Date(baseMs + deltaDays * DASHBOARD_RSS_DAY_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
};

export function dashboardBuildRecentExpenses_(cashFlow) {
  const rows = Array.isArray(cashFlow) ? cashFlow : [];

  let latestDate = '';
  rows.forEach((item) => {
    if (item?.date && item.date > latestDate) latestDate = item.date;
  });
  if (!latestDate) {
    return { hasData: false, latestDate: '', fromDate: '', groups: [], totalYen: 0 };
  }

  const fromDate = dashboardShiftDateKey_(latestDate, -(DASHBOARD_RECENT_EXPENSE_DAYS - 1));
  const byDate = new Map();
  rows.filter(dashboardIsRecentSpending_).forEach((item) => {
    if (!item.date || item.date < fromDate || item.date > latestDate) return;
    const entries = byDate.get(item.date) ?? [];
    entries.push({
      date: item.date,
      name: item.name,
      category: item.category,
      amountYen: Math.abs(Number(item.amount)),
    });
    byDate.set(item.date, entries);
  });

  const groups = Array.from(byDate, ([date, items]) => {
    const sorted = [...items].sort((a, b) => b.amountYen - a.amountYen);
    return {
      date,
      items: sorted,
      totalYen: sorted.reduce((sum, entry) => sum + entry.amountYen, 0),
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  return {
    hasData: groups.length > 0,
    latestDate,
    fromDate,
    groups,
    totalYen: groups.reduce((sum, group) => sum + group.totalYen, 0),
  };
}

// --- Headline (port of the front end's domain/home/headline):
// net assets versus the previous snapshot month, plus the
// pace read from the full-FIRE projection delta. ---

export function dashboardBuildHeadline_({ snapshots, currentNetAssetsYen = 0, projectionDeltaMonths = null } = {}) {
  const rows = (Array.isArray(snapshots) ? [...snapshots] : []).sort((a, b) =>
    String(a?.month ?? '').localeCompare(String(b?.month ?? '')),
  );
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];

  if (!previous || !latest) {
    return {
      hasComparison: false,
      month: latest?.month ?? '',
      previousMonth: '',
      netAssetsYen: currentNetAssetsYen || latest?.netAssetsYen || 0,
      diffYen: null,
      diffRatePct: null,
      pace: null,
      projectionDeltaMonths: null,
    };
  }

  const pace =
    projectionDeltaMonths == null
      ? null
      : projectionDeltaMonths > 0
        ? 'improving'
        : projectionDeltaMonths < 0
          ? 'worsening'
          : 'steady';

  const diffYen = latest.netAssetsYen - previous.netAssetsYen;
  return {
    hasComparison: true,
    month: latest.month,
    previousMonth: previous.month,
    netAssetsYen: latest.netAssetsYen,
    diffYen,
    diffRatePct: dashboardDiffRatePct_(diffYen, previous.netAssetsYen),
    pace,
    projectionDeltaMonths,
  };
}

// --- FIRE engine (ports of the front end's domain/fire,
// domain/family and domain/progress). The home screen's FIRE
// summary runs the same simulation with the same default
// assumptions as the FIRE screens; the ports below keep the
// arithmetic identical, including the pension model. ---

const DASHBOARD_USER_BIRTH_DATE = '1979-09-02';
const DASHBOARD_UNIVERSITY_FUND_YEN = 10450000;
const DASHBOARD_SIDE_FIRE_ANNUAL_INCOME_YEN = 4000000;
// Daughter's independence month (born 2013-02-20, starts
// working from 2037-04), as in the front end's engine.
const DASHBOARD_INDEPENDENCE_MONTH_KEY = '2037-04';

const dashboardCalculateAge_ = (birthDateStr, baseDate = new Date()) => {
  const [birthYear, birthMonth, birthDay] = String(birthDateStr).split('-').map(Number);
  let age = baseDate.getFullYear() - birthYear;
  const m = baseDate.getMonth() + 1 - birthMonth;
  if (m < 0 || (m === 0 && baseDate.getDate() < birthDay)) {
    age--;
  }
  return age;
};

// Pension model (port of domain/fire/pension).
const DASHBOARD_PENSION_USER_START_AGE = 60;
const DASHBOARD_PENSION_SPOUSE_USER_AGE_START = 62;
const DASHBOARD_PENSION_BASIC_FULL = 780000;
const DASHBOARD_PENSION_BASIC_REDUCTION = 0.9;
const DASHBOARD_PENSION_EARLY_REDUCTION = 0.76;
const DASHBOARD_PENSION_DATA_AGE = 44;
const DASHBOARD_PENSION_USER_KOSEN_ACCRUED_AT_44 = 892252;
const DASHBOARD_PENSION_USER_KOSEN_FUTURE_FACTOR = 42000;

const dashboardCalculateMonthlyPension_ = (age, fireAge) => {
  let totalAnnual = 0;

  if (age >= DASHBOARD_PENSION_USER_START_AGE) {
    const basicPart =
      DASHBOARD_PENSION_BASIC_FULL * DASHBOARD_PENSION_BASIC_REDUCTION * DASHBOARD_PENSION_EARLY_REDUCTION;
    const participationEndAge = Math.min(60, fireAge);
    const futureYears = Math.max(0, participationEndAge - DASHBOARD_PENSION_DATA_AGE);
    const employeesPartAt65 =
      DASHBOARD_PENSION_USER_KOSEN_ACCRUED_AT_44 + futureYears * DASHBOARD_PENSION_USER_KOSEN_FUTURE_FACTOR;

    totalAnnual += basicPart + employeesPartAt65 * DASHBOARD_PENSION_EARLY_REDUCTION;
  }

  if (age >= DASHBOARD_PENSION_SPOUSE_USER_AGE_START) {
    totalAnnual += DASHBOARD_PENSION_BASIC_FULL;
  }

  return Math.round(totalAnnual / 12);
};

// Asset ownership detection (port of domain/family/engine):
// rows carrying the wife's or daughter's account suffix belong
// to them; everything else is the owner's.
const DASHBOARD_OWNER_RULES = [
  { id: 'wife', suffix: '@chipop' },
  { id: 'daughter', suffix: '@aojiru.pudding' },
];
const DASHBOARD_ASSET_FIELD_CANDIDATES = ['残高', '評価額', '現在価値', '現在の価値', 'amount_yen', '金額'];

const dashboardDetectAssetOwnerId_ = (row) => {
  if (!row || typeof row !== 'object') {
    return 'me';
  }
  const merged = Object.values(row)
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const matched = DASHBOARD_OWNER_RULES.find((rule) => merged.includes(rule.suffix));
  return matched ? matched.id : 'me';
};

const dashboardAssetAmountYen_ = (row) => {
  if (!row || typeof row !== 'object') {
    return 0;
  }
  for (const key of DASHBOARD_ASSET_FIELD_CANDIDATES) {
    if (key in row) {
      return dashboardToNumber_(row[key]);
    }
  }
  return 0;
};

// Port of calculateFirePortfolio: totals over the owner's and
// wife's holdings only.
const dashboardCalculateFirePortfolio_ = (portfolio, includedOwnerIds = ['me', 'wife']) => {
  if (!portfolio?.holdings) {
    return { totalAssetsYen: 0, riskAssetsYen: 0, cashAssetsYen: 0, liabilitiesYen: 0, netWorthYen: 0 };
  }

  const riskCategories = [
    '株式（現物）',
    '株式（信用）',
    '投資信託',
    '年金',
    '先物・オプション',
    '外貨預金',
    '債券',
  ];

  const allAssetKeys = ['cashLike', 'stocks', 'funds', 'pensions', 'points'];
  const riskAssetKeys = new Set(['stocks', 'funds', 'pensions']);

  let totalAssetsYen = 0;
  let riskAssetsYen = 0;

  allAssetKeys.forEach((key) => {
    const rows = Array.isArray(portfolio.holdings?.[key]) ? portfolio.holdings[key] : [];
    rows.forEach((row) => {
      const ownerId = dashboardDetectAssetOwnerId_(row);
      if (!includedOwnerIds.includes(ownerId)) return;

      const amount = dashboardAssetAmountYen_(row);
      totalAssetsYen += amount;

      const category = row.category || '';
      if (riskAssetKeys.has(key) || riskCategories.includes(category)) {
        riskAssetsYen += amount;
      }
    });
  });

  const liabilitiesRows = Array.isArray(portfolio.holdings?.liabilitiesDetail)
    ? portfolio.holdings.liabilitiesDetail
    : [];
  const liabilitiesYen = liabilitiesRows.reduce((sum, row) => {
    const ownerId = dashboardDetectAssetOwnerId_(row);
    if (!includedOwnerIds.includes(ownerId)) return sum;
    return sum + dashboardAssetAmountYen_(row);
  }, 0);

  const cashAssetsYen = Math.max(0, totalAssetsYen - riskAssetsYen);
  const netWorthYen = totalAssetsYen - liabilitiesYen;

  return { totalAssetsYen, riskAssetsYen, cashAssetsYen, liabilitiesYen, netWorthYen };
};

// --- Past-12-month estimates (ports of the engine's
// estimate* functions): the lookback window is the 12 months
// before the current month, always divided by 12. ---

const DASHBOARD_TWELVE_MONTH_LOOKBACK_COUNT = 12;

const dashboardGetPastMonths_ = (now, count) => {
  const months = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
};

const dashboardProcessLookbackCashFlow_ = (cashFlow, callback) => {
  const now = new Date();
  const targetMonths = dashboardGetPastMonths_(now, DASHBOARD_TWELVE_MONTH_LOOKBACK_COUNT);
  const monthSet = new Set(targetMonths);

  cashFlow.forEach((item) => {
    if (item.isTransfer) return;
    const month = item.date?.substring(0, 7) || '';
    if (!monthSet.has(month)) return;
    callback(item);
  });
};

const dashboardEstimateMonthlyExpenses_ = (cashFlow) => {
  const divisor = DASHBOARD_TWELVE_MONTH_LOOKBACK_COUNT;
  const breakdownMap = {};
  let totalNormalExpense = 0;
  let totalSpecialExpense = 0;
  let totalFixedExpense = 0;
  let totalVariableExpense = 0;

  dashboardProcessLookbackCashFlow_(cashFlow, (item) => {
    if (item.amount >= 0) return;

    const absAmount = Math.abs(item.amount);
    const category = item.category || '未分類';
    const type = dashboardGetExpenseType_(item);

    if (type === 'exclude') {
      if (category.startsWith('特別な支出')) {
        totalSpecialExpense += absAmount;
      }
      return;
    }

    if (type === 'fixed') {
      totalFixedExpense += absAmount;
    } else {
      totalVariableExpense += absAmount;
    }

    totalNormalExpense += absAmount;
    const largeCat = category.split('/')[0];
    breakdownMap[largeCat] = (breakdownMap[largeCat] || 0) + absAmount;
  });

  const breakdown = Object.entries(breakdownMap)
    .map(([name, total]) => ({
      name,
      amount: Math.round(total / divisor),
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    total: Math.round(totalNormalExpense / divisor),
    breakdown,
    averageSpecial: Math.round(totalSpecialExpense / divisor),
    averageFixed: Math.round(totalFixedExpense / divisor),
    averageVariable: Math.round(totalVariableExpense / divisor),
    monthCount: divisor,
  };
};

const dashboardEstimateIncomeSplit_ = (cashFlow) => {
  const divisor = DASHBOARD_TWELVE_MONTH_LOOKBACK_COUNT;
  let totalRegularIncome = 0;
  const regularBreakdownMap = {};
  const monthlyTotals = {};

  dashboardProcessLookbackCashFlow_(cashFlow, (item) => {
    if (item.amount <= 0) return;

    const category = item.category || '未分類';
    if (!category.startsWith('収入/')) return;

    const month = item.date?.substring(0, 7) || 'unknown';
    if (!monthlyTotals[month]) {
      monthlyTotals[month] = { totalIncome: 0, bonusSum: 0 };
    }
    monthlyTotals[month].totalIncome += item.amount;

    if (category === '収入/給与') {
      totalRegularIncome += item.amount;
      regularBreakdownMap[category] = (regularBreakdownMap[category] || 0) + item.amount;
    } else if (category === '収入/一時所得') {
      monthlyTotals[month].bonusSum += item.amount;
    }
  });

  let peakMonth = null;
  let maxTotalIncome = -1;
  Object.entries(monthlyTotals).forEach(([month, data]) => {
    if (data.totalIncome > maxTotalIncome) {
      maxTotalIncome = data.totalIncome;
      peakMonth = month;
    }
  });

  const bonusAnnual = peakMonth ? monthlyTotals[peakMonth].bonusSum * 2 : 0;
  const regularMonthly = Math.round(totalRegularIncome / divisor);

  const regularBreakdown = Object.entries(regularBreakdownMap).map(([name, total]) => ({
    name,
    amount: Math.round(total / divisor),
  }));
  regularBreakdown.sort((a, b) => b.amount - a.amount);

  const bonusBreakdown =
    peakMonth && monthlyTotals[peakMonth].bonusSum > 0
      ? [
          {
            name: `収入/一時所得 (${peakMonth}ピーク x2)`,
            amount: bonusAnnual,
          },
        ]
      : [];

  return {
    regularMonthly,
    bonusAnnual,
    monthlyTotal: regularMonthly + bonusAnnual / 12,
    regularBreakdown,
    bonusBreakdown,
    monthCount: divisor,
  };
};

const dashboardGetPast12MonthSummary_ = (cashFlow) => {
  const expenses = dashboardEstimateMonthlyExpenses_(cashFlow);
  const income = dashboardEstimateIncomeSplit_(cashFlow);

  return {
    monthlyLivingExpenses: {
      average: expenses.total,
      breakdown: expenses.breakdown,
      averageSpecial: expenses.averageSpecial,
    },
    monthlyRegularIncome: {
      average: income.regularMonthly,
      breakdown: income.regularBreakdown,
    },
    annualBonus: {
      average: income.bonusAnnual,
      breakdown: income.bonusBreakdown,
    },
    avgFixedMonthly: expenses.averageFixed,
    avgVariableMonthly: expenses.averageVariable,
    monthCount: expenses.monthCount,
  };
};

const dashboardEstimateMortgageMonthlyPayment_ = (cashFlow) => {
  const divisor = DASHBOARD_TWELVE_MONTH_LOOKBACK_COUNT;
  let totalMortgage = 0;

  dashboardProcessLookbackCashFlow_(cashFlow, (item) => {
    if (item.amount >= 0) return;
    if ((item.category || '').startsWith('住宅/ローン返済')) {
      totalMortgage += Math.abs(item.amount);
    }
  });

  return Math.round(totalMortgage / divisor);
};

// The default simulation assumptions, assembled exactly as
// the front end's useFireBaseParams does from the simulator
// store's defaults (auto values throughout).
const dashboardBuildFireBaseParams_ = (portfolio) => {
  const summary = dashboardGetPast12MonthSummary_(portfolio.cashFlow);
  const monthlyIncome = summary.monthlyRegularIncome.average + summary.annualBonus.average / 12;
  const autoPostFireFirstYearExtraExpense = Math.round(((monthlyIncome * 12) * 0.15) / 10000) * 10000;
  return {
    annualReturnRate: 5 / 100,
    monthlyExpense: summary.monthlyLivingExpenses.average,
    monthlyIncome,
    currentAge: dashboardCalculateAge_(DASHBOARD_USER_BIRTH_DATE),
    includeInflation: true,
    inflationRate: 2 / 100,
    includeTax: true,
    taxRate: 20.315 / 100,
    withdrawalRate: 4 / 100,
    mortgageMonthlyPayment: dashboardEstimateMortgageMonthlyPayment_(portfolio.cashFlow),
    mortgagePayoffDate: '2042-05',
    postFireExtraExpense: 60000,
    postFireFirstYearExtraExpense: autoPostFireFirstYearExtraExpense,
    retirementLumpSumAtFire: 5000000,
    includePension: true,
    monthlyInvestment: 423000,
    expenseBreakdown: summary.monthlyLivingExpenses.breakdown,
  };
};

// --- Simulation core (port of the engine's
// normalizeFireParams / _runCoreSimulation and helpers) ---

const dashboardCalculateLifestyleReduction_ = (breakdown) => {
  if (!breakdown || !Array.isArray(breakdown) || breakdown.length === 0) {
    return 1.0;
  }

  const reductionRules = {
    '食費': 2 / 3,
    '教養・教育': 0,
    '通信費': 2 / 3,
    '衣服・美容': 2 / 3,
    '日用品': 2 / 3,
  };

  let originalTotal = 0;
  let reducedTotal = 0;

  breakdown.forEach((item) => {
    originalTotal += item.amount;
    const multiplier = reductionRules[item.name] ?? 1.0;
    reducedTotal += item.amount * multiplier;
  });

  if (originalTotal === 0) return 1.0;
  return reducedTotal / originalTotal;
};

const dashboardNormalizeFireParams_ = (params) => {
  if (!params) return dashboardNormalizeFireParams_({});
  const monthlyExpense = params.monthlyExpense ?? (params.monthlyExpenses ? params.monthlyExpenses / 12 : 0);
  return {
    initialAssets: Number(params.initialAssets ?? 0),
    riskAssets: Number(params.riskAssets ?? 0),
    annualReturnRate: Number(params.annualReturnRate ?? 0),
    monthlyExpense: Number(monthlyExpense),
    monthlyIncome: Number(params.monthlyIncome ?? 0),
    currentAge: Number(params.currentAge || 40),
    includeInflation: Boolean(params.includeInflation),
    inflationRate: Number(params.inflationRate ?? 0.02),
    includeTax: Boolean(params.includeTax),
    taxRate: Number(params.taxRate ?? 0.20315),
    withdrawalRate: Number(params.withdrawalRate ?? 0.04),
    mortgageMonthlyPayment: Number(params.mortgageMonthlyPayment ?? 0),
    mortgagePayoffDate: params.mortgagePayoffDate || null,
    postFireExtraExpense: Number(params.postFireExtraExpense ?? 0),
    postFireFirstYearExtraExpense: Number(params.postFireFirstYearExtraExpense ?? 0),
    retirementLumpSumAtFire: Number(params.retirementLumpSumAtFire ?? 5000000),
    includePension: Boolean(params.includePension),
    monthlyInvestment: Number(params.monthlyInvestment ?? 0),
    maxMonths: Number(params.maxMonths ?? 1200),
    expenseBreakdown: params.expenseBreakdown || null,
  };
};

const dashboardCalculateRequiredAssets_ = ({
  monthlyExpense,
  monthlyReturn,
  monthlyInflation,
  remainingMonths,
  taxRate,
  includeTax,
  currentAgeInSimulation,
  includePension = true,
  withdrawalRate = 0.04,
}) => {
  if (remainingMonths <= 0) return 0;

  const r = monthlyReturn;
  const g = monthlyInflation;
  const w = withdrawalRate / 12;
  const t = includeTax ? taxRate : 0;

  let A = 0;
  for (let i = remainingMonths - 1; i >= 0; i--) {
    const age = currentAgeInSimulation + i / 12;
    const P = includePension ? dashboardCalculateMonthlyPension_(age, currentAgeInSimulation) : 0;
    const E = monthlyExpense * Math.pow(1 + g, i);

    const W_expense = Math.max(0, E - P);

    const A_case1 = A / (1 + r) + W_expense / (1 - t);

    const A_case2 = (A / (1 + r) - P / (1 - t)) / (1 - w / (1 - t));

    A = Math.max(A_case1, A_case2);
  }

  return Math.max(0, A);
};

const dashboardToMonthKey_ = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const dashboardCalculateCurrentMonthlyExpense_ = ({
  baseMonthlyExpense,
  monthlyInflationRate,
  monthIndex,
  simulationStartDate,
  mortgageMonthlyPayment,
  mortgagePayoffDate,
  lifestyleReductionFactor = 1.0,
}) => {
  const mortgage = mortgageMonthlyPayment || 0;
  const nonMortgageExpense = Math.max(0, baseMonthlyExpense - mortgage);

  const currentDate = new Date(simulationStartDate);
  currentDate.setMonth(currentDate.getMonth() + monthIndex);
  const currentMonthKey = dashboardToMonthKey_(currentDate);

  const isIndependent = currentMonthKey >= DASHBOARD_INDEPENDENCE_MONTH_KEY;
  const effectiveReduction = isIndependent ? lifestyleReductionFactor : 1.0;

  const inflatedNonMortgage = nonMortgageExpense * effectiveReduction * Math.pow(1 + monthlyInflationRate, monthIndex);

  if (!mortgage || !mortgagePayoffDate) {
    return inflatedNonMortgage + mortgage;
  }

  if (currentMonthKey > mortgagePayoffDate) {
    return inflatedNonMortgage;
  }

  return inflatedNonMortgage + mortgage;
};

const dashboardRunCoreSimulation_ = (params, { recordMonthly = false, fireMonth = -1, returnsArray = null } = {}) => {
  const {
    initialAssets,
    riskAssets,
    annualReturnRate,
    monthlyExpense,
    monthlyIncome,
    currentAge,
    maxMonths,
    includeInflation,
    inflationRate,
    includeTax,
    taxRate,
    withdrawalRate,
    mortgageMonthlyPayment,
    mortgagePayoffDate,
    postFireExtraExpense,
    postFireFirstYearExtraExpense,
    retirementLumpSumAtFire,
    includePension,
    monthlyInvestment,
  } = params;

  const monthlyExp = monthlyExpense;
  const monthlyReturnMean = Math.pow(1 + annualReturnRate, 1 / 12) - 1;
  const monthlyInflationRate = Math.pow(1 + (includeInflation ? inflationRate : 0), 1 / 12) - 1;
  const totalMonthsUntil100 = (100 - currentAge) * 12;
  const simulationStartDate = new Date();

  let currentRisk = riskAssets;
  let currentCostBasis = riskAssets;
  let currentCash = initialAssets - riskAssets;
  let fireReachedMonth = fireMonth;
  const monthlyData = recordMonthly ? [] : null;

  const simulationLimit = totalMonthsUntil100;
  const lifestyleReductionFactor = dashboardCalculateLifestyleReduction_(params.expenseBreakdown);

  for (let m = 0; m <= simulationLimit; m++) {
    const ageAtMonthM = currentAge + m / 12;
    const remainingMonths = Math.max(0, totalMonthsUntil100 - m);

    if (m === fireReachedMonth) {
      currentCash += retirementLumpSumAtFire;
    }

    const curMonthlyExp = dashboardCalculateCurrentMonthlyExpense_({
      baseMonthlyExpense: monthlyExp,
      monthlyInflationRate,
      monthIndex: m,
      simulationStartDate,
      mortgageMonthlyPayment,
      mortgagePayoffDate,
      lifestyleReductionFactor,
    });
    const extraWithInf = postFireExtraExpense * Math.pow(1 + monthlyInflationRate, m);

    let firstYearSpikeWithInf = 0;
    if (fireReachedMonth !== -1 && m >= fireReachedMonth && m < fireReachedMonth + 12) {
      firstYearSpikeWithInf = (postFireFirstYearExtraExpense / 12) * Math.pow(1 + monthlyInflationRate, m);
    }

    const assets = Math.max(0, currentCash + currentRisk);

    const isFire = fireReachedMonth !== -1 && m >= fireReachedMonth;
    const fireAgeAtMonthM = fireReachedMonth === -1 ? currentAge + 100 : currentAge + fireReachedMonth / 12;
    const curPension = includePension ? dashboardCalculateMonthlyPension_(ageAtMonthM, fireAgeAtMonthM) : 0;

    const monthlyIncomeVal = isFire ? 0 : monthlyIncome;
    const monthlyExpensesVal = curMonthlyExp + (isFire ? extraWithInf : 0) + firstYearSpikeWithInf;
    const incomeAvailable = monthlyIncomeVal + curPension;

    if (recordMonthly && m <= maxMonths) {
      const reqAssets = dashboardCalculateRequiredAssets_({
        monthlyExpense: curMonthlyExp + extraWithInf + (m >= fireReachedMonth && m < fireReachedMonth + 12 ? (postFireFirstYearExtraExpense / 12) * Math.pow(1 + monthlyInflationRate, m) : 0),
        monthlyReturn: monthlyReturnMean,
        monthlyInflation: monthlyInflationRate,
        remainingMonths,
        taxRate,
        includeTax,
        currentAgeInSimulation: ageAtMonthM,
        includePension,
        withdrawalRate,
      });

      monthlyData.push({
        month: m,
        age: ageAtMonthM,
        assets,
        riskAssets: currentRisk,
        cashAssets: currentCash,
        requiredAssets: reqAssets,
        isFire,
        income: monthlyIncomeVal,
        pension: curPension,
        expenses: monthlyExpensesVal,
        investmentGain: 0,
        withdrawal: 0,
      });
    }

    if (m === totalMonthsUntil100) break;

    let monthlyWithdrawal = 0;
    let monthlyInvest = 0;
    let investmentGain = 0;
    const returnRate = returnsArray[m];

    if (!isFire) {
      const netFlow = incomeAvailable - monthlyExpensesVal;
      const cashAfterFlow = currentCash + netFlow;

      if (cashAfterFlow < 0) {
        const needed = Math.abs(cashAfterFlow);

        const gainRatio = currentRisk > 0 ? Math.max(0, (currentRisk - currentCostBasis) / currentRisk) : 0;
        const maxNetFromRisk = Math.max(0, currentRisk * (1 - (includeTax ? gainRatio * taxRate : 0)));
        const actualNetFromRisk = Math.min(needed, maxNetFromRisk);
        const grossFromRisk = actualNetFromRisk / (1 - (includeTax ? gainRatio * taxRate : 0));

        const costBasisWithdrawn = grossFromRisk * (1 - gainRatio);
        currentCostBasis -= costBasisWithdrawn;
        currentRisk -= grossFromRisk;
        currentRisk = Math.max(0, currentRisk);
        currentCostBasis = Math.max(0, currentCostBasis);

        currentCash = cashAfterFlow + actualNetFromRisk;
        monthlyWithdrawal = actualNetFromRisk > 0 ? grossFromRisk : 0;
      } else {
        monthlyInvest = Math.min(monthlyInvestment, cashAfterFlow);
        currentCash = cashAfterFlow - monthlyInvest;
        currentRisk += monthlyInvest;
        currentCostBasis += monthlyInvest;
        monthlyWithdrawal = 0;
      }
    } else {
      const targetWithdrawalFromAssets = (assets * withdrawalRate) / 12;
      const expenseShortfall = Math.max(0, monthlyExpensesVal - incomeAvailable);
      const netToTakeFromAssets = Math.max(expenseShortfall, targetWithdrawalFromAssets);

      const takenFromCash = Math.min(currentCash, netToTakeFromAssets);
      const remainingShortfall = netToTakeFromAssets - takenFromCash;

      const gainRatio = currentRisk > 0 ? Math.max(0, (currentRisk - currentCostBasis) / currentRisk) : 0;
      const maxNetFromRisk = Math.max(0, currentRisk * (1 - (includeTax ? gainRatio * taxRate : 0)));
      const actualNetFromRisk = Math.min(remainingShortfall, maxNetFromRisk);
      const grossFromRisk = actualNetFromRisk / (1 - (includeTax ? gainRatio * taxRate : 0));

      const costBasisWithdrawn = grossFromRisk * (1 - gainRatio);
      currentCostBasis -= costBasisWithdrawn;
      currentRisk -= grossFromRisk;
      currentRisk = Math.max(0, currentRisk);
      currentCostBasis = Math.max(0, currentCostBasis);

      currentCash += incomeAvailable + actualNetFromRisk - monthlyExpensesVal;

      monthlyWithdrawal = takenFromCash + grossFromRisk;
    }

    investmentGain = currentRisk * returnRate;
    currentRisk += investmentGain;

    if (recordMonthly && m <= maxMonths) {
      const last = monthlyData[monthlyData.length - 1];
      if (last) {
        last.investmentGain = investmentGain;
        last.withdrawal = monthlyWithdrawal;
      }
    }
  }

  const survived = currentCash + currentRisk >= 0;
  return { fireReachedMonth, monthlyData, survived, finalAssets: currentCash + currentRisk };
};

const dashboardFindSurvivalMonth_ = (params, returnsArray = null) => {
  const { currentAge, maxMonths } = params;
  const totalMonthsLimit = Math.min(maxMonths, (100 - currentAge) * 12);

  let result = -1;

  for (let m = 0; m <= totalMonthsLimit; m += 12) {
    const res = dashboardRunCoreSimulation_(params, { fireMonth: m, returnsArray });
    if (res.survived) {
      result = m;
      break;
    }
  }

  if (result !== -1) {
    let monthlyLow = Math.max(0, result - 11);
    let monthlyHigh = result;
    while (monthlyLow <= monthlyHigh) {
      const mid = Math.floor((monthlyLow + monthlyHigh) / 2);
      const res = dashboardRunCoreSimulation_(params, { fireMonth: mid, returnsArray });
      if (res.survived) {
        result = mid;
        monthlyHigh = mid - 1;
      } else {
        monthlyLow = mid + 1;
      }
    }
  }

  return result;
};

const dashboardPerformFireSimulation_ = (inputParams, options = {}) => {
  const params = dashboardNormalizeFireParams_(inputParams);
  const { forceFireMonth = null, returnsArray = null, recordMonthly = false } = options;

  let targetReturns = returnsArray;
  if (!targetReturns) {
    const { currentAge, annualReturnRate } = params;
    const totalMonthsUntil100 = (100 - currentAge) * 12;
    const monthlyReturnMean = Math.pow(1 + annualReturnRate, 1 / 12) - 1;

    targetReturns = [];
    for (let m = 0; m <= totalMonthsUntil100; m++) {
      targetReturns.push(monthlyReturnMean);
    }
  }

  let fireMonth = forceFireMonth;
  if (fireMonth === null) {
    fireMonth = dashboardFindSurvivalMonth_(params, targetReturns);
  }

  return dashboardRunCoreSimulation_(params, {
    recordMonthly,
    fireMonth,
    returnsArray: targetReturns,
  });
};

const dashboardGenerateGrowthTable_ = (params) => {
  const { monthlyData, fireReachedMonth } = dashboardPerformFireSimulation_(params, { recordMonthly: true });
  return {
    table: monthlyData.map((d) => ({
      month: d.month,
      age: d.age,
      assets: d.assets,
      requiredAssets: d.requiredAssets,
      isFire: d.isFire,
    })),
    fireReachedMonth,
  };
};

// --- FIRE progress (port of domain/progress) ---

const dashboardSummarizeRun_ = (params, currentAssetsYen) => {
  const { table, fireReachedMonth } = dashboardGenerateGrowthTable_(params);
  const reached = fireReachedMonth >= 0 && fireReachedMonth < 1200;
  if (!reached) {
    return {
      reached: false,
      alreadyReached: false,
      monthsToReach: null,
      requiredAssetsYen: null,
      progressRate: null,
      gapYen: null,
    };
  }
  if (fireReachedMonth === 0) {
    return {
      reached: true,
      alreadyReached: true,
      monthsToReach: 0,
      requiredAssetsYen: currentAssetsYen,
      progressRate: 1,
      gapYen: 0,
    };
  }
  const firePoint = table.find((row) => row.month === fireReachedMonth);
  const requiredAssetsYen = Math.round(firePoint?.assets ?? 0);
  return {
    reached: true,
    alreadyReached: false,
    monthsToReach: fireReachedMonth,
    requiredAssetsYen,
    progressRate: requiredAssetsYen > 0 ? currentAssetsYen / requiredAssetsYen : null,
    gapYen: requiredAssetsYen - currentAssetsYen,
  };
};

export function dashboardBuildFireProgress_({
  portfolio,
  baseParams,
  universityFundYen = DASHBOARD_UNIVERSITY_FUND_YEN,
  sideFireAnnualIncomeYen = DASHBOARD_SIDE_FIRE_ANNUAL_INCOME_YEN,
}) {
  const totalAssetsYen = Number(portfolio?.totals?.assetsYen ?? 0);
  const fireTargetAssetsYen = Math.max(0, totalAssetsYen - universityFundYen);
  const firePortfolio = dashboardCalculateFirePortfolio_(portfolio);
  const riskAssetsYen = Math.min(firePortfolio.riskAssetsYen, fireTargetAssetsYen);

  const sharedParams = {
    ...baseParams,
    riskAssets: riskAssetsYen,
  };

  const sideFireMonthlyIncomeYen = Math.round(sideFireAnnualIncomeYen / 12);
  const side = dashboardSummarizeRun_(
    {
      ...sharedParams,
      initialAssets: fireTargetAssetsYen,
      postFireExtraExpense:
        Number(baseParams?.postFireExtraExpense ?? 0) - sideFireMonthlyIncomeYen,
    },
    fireTargetAssetsYen,
  );

  const full = dashboardSummarizeRun_(
    {
      ...baseParams,
      initialAssets: firePortfolio.totalAssetsYen,
      riskAssets: firePortfolio.riskAssetsYen,
    },
    firePortfolio.totalAssetsYen,
  );

  return {
    totalAssetsYen,
    fullAssetsYen: firePortfolio.totalAssetsYen,
    universityFundYen,
    fireTargetAssetsYen,
    sideFireAnnualIncomeYen,
    side,
    full,
  };
}

// --- Asset goals (port of buildAssetGoals /
// projectAssetGoals / projectLiabilitiesYen in
// domain/progress): progress toward ¥100M in total assets
// and in net assets. The projection reuses the FIRE engine's
// accumulation phase (retirement forced to age 100, i.e. the
// user keeps working) under the same assumptions as the
// front end, and finds the first month each balance crosses
// the goal. Liabilities are approximated: the mortgage
// portion (monthly payment × months until payoff, capped at
// the current balance) declines by the payment each month
// (principal-only approximation; interest is not separated),
// and other liabilities stay constant.

const DASHBOARD_ASSET_GOAL_YEN = 100000000;

export function dashboardProjectLiabilitiesYen_({
  currentLiabilitiesYen,
  mortgageMonthlyPayment,
  mortgagePayoffDate,
  startMonthKey,
  monthOffset,
}) {
  const total = Math.max(0, Number(currentLiabilitiesYen ?? 0));
  const payment = Math.max(0, Number(mortgageMonthlyPayment ?? 0));
  if (
    !payment ||
    !mortgagePayoffDate ||
    !dashboardParseMonthKey_(mortgagePayoffDate) ||
    !dashboardParseMonthKey_(startMonthKey)
  ) {
    return total;
  }
  const remainingMonths = Math.max(
    0,
    dashboardMonthKeyToIndex_(mortgagePayoffDate) - dashboardMonthKeyToIndex_(startMonthKey) + 1,
  );
  const mortgageBalance = Math.min(total, payment * remainingMonths);
  const otherLiabilities = total - mortgageBalance;
  return otherLiabilities + Math.max(0, mortgageBalance - payment * monthOffset);
}

const dashboardProjectAssetGoals_ = ({
  totalAssetsYen,
  liabilitiesYen,
  riskAssetsYen,
  params,
  startMonthKey,
}) => {
  const goalYen = DASHBOARD_ASSET_GOAL_YEN;
  const totalMonths = (100 - Number(params.currentAge || 40)) * 12;
  const { monthlyData } = dashboardPerformFireSimulation_(
    { ...params, initialAssets: totalAssetsYen, riskAssets: riskAssetsYen },
    { forceFireMonth: totalMonths, recordMonthly: true },
  );
  const series = monthlyData.map((row) => {
    const liabilities = dashboardProjectLiabilitiesYen_({
      currentLiabilitiesYen: liabilitiesYen,
      mortgageMonthlyPayment: params.mortgageMonthlyPayment,
      mortgagePayoffDate: params.mortgagePayoffDate,
      startMonthKey,
      monthOffset: row.month,
    });
    return {
      monthOffset: row.month,
      monthKey: dashboardAddMonthsToMonthKey_(startMonthKey, row.month),
      totalAssetsYen: Math.round(row.assets),
      liabilitiesYen: Math.round(liabilities),
      netAssetsYen: Math.round(row.assets - liabilities),
    };
  });

  const summarize = (currentYen, pick) => {
    const reachedIndex = series.findIndex((row) => pick(row) >= goalYen);
    if (currentYen >= goalYen) {
      return {
        reached: true,
        alreadyReached: true,
        monthsToReach: 0,
        projectedMonth: startMonthKey,
        progressRate: currentYen / goalYen,
      };
    }
    if (reachedIndex < 0) {
      return {
        reached: false,
        alreadyReached: false,
        monthsToReach: null,
        projectedMonth: null,
        progressRate: currentYen / goalYen,
      };
    }
    return {
      reached: true,
      alreadyReached: false,
      monthsToReach: reachedIndex,
      projectedMonth: series[reachedIndex].monthKey,
      progressRate: currentYen / goalYen,
    };
  };

  const netAssetsYen = totalAssetsYen - liabilitiesYen;
  return {
    goalYen,
    totalAssetsYen,
    liabilitiesYen,
    netAssetsYen,
    total: summarize(totalAssetsYen, (row) => row.totalAssetsYen),
    net: summarize(netAssetsYen, (row) => row.netAssetsYen),
    series,
  };
};

export function dashboardBuildAssetGoals_({ portfolio, baseParams, startMonthKey }) {
  const totalAssetsYen = Number(portfolio?.totals?.assetsYen ?? 0);
  const liabilitiesYen = Number(portfolio?.totals?.liabilitiesYen ?? 0);
  const firePortfolio = dashboardCalculateFirePortfolio_(portfolio);
  const riskAssetsYen = Math.min(firePortfolio.riskAssetsYen, totalAssetsYen);
  return dashboardProjectAssetGoals_({
    totalAssetsYen,
    liabilitiesYen,
    riskAssetsYen,
    params: { ...baseParams },
    startMonthKey,
  });
}

// Projection trend across snapshot months (port of
// buildProjectionTrend): each snapshot month is re-run
// through the engine with that month's assets and averages
// under today's assumptions.
const dashboardParseMonthKey_ = (monthKey) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
};

const dashboardMonthKeyToIndex_ = (monthKey) => {
  const parsed = dashboardParseMonthKey_(monthKey);
  if (!parsed) return null;
  return parsed.year * 12 + (parsed.month - 1);
};

const dashboardIndexToMonthKey_ = (index) => {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
};

const dashboardAddMonthsToMonthKey_ = (monthKey, months) => {
  const index = dashboardMonthKeyToIndex_(monthKey);
  if (index == null) return null;
  return dashboardIndexToMonthKey_(index + months);
};

const dashboardAgeAtSnapshotMonth_ = (monthKey) => {
  const parsed = dashboardParseMonthKey_(monthKey);
  if (!parsed) return null;
  return dashboardCalculateAge_(DASHBOARD_USER_BIRTH_DATE, new Date(parsed.year, parsed.month, 0));
};

const dashboardEstimateReach_ = (params) => {
  const { fireReachedMonth } = dashboardPerformFireSimulation_(params);
  const reached = fireReachedMonth >= 0 && fireReachedMonth < 1200;
  if (!reached) {
    return { reached: false, alreadyReached: false, monthsToReach: null };
  }
  return {
    reached: true,
    alreadyReached: fireReachedMonth === 0,
    monthsToReach: fireReachedMonth,
  };
};

const dashboardBuildRetrospectiveParams_ = ({
  snapshot,
  baseParams,
  initialAssetsYen,
  riskAssetsYen,
  postFireExtraExpenseAdjustmentYen = 0,
}) => ({
  ...baseParams,
  initialAssets: initialAssetsYen,
  riskAssets: riskAssetsYen,
  currentAge: dashboardAgeAtSnapshotMonth_(snapshot.month) ?? baseParams.currentAge,
  monthlyExpense:
    snapshot.livingCost12mAvgYen > 0 ? snapshot.livingCost12mAvgYen : baseParams.monthlyExpense,
  monthlyIncome:
    snapshot.income12mAvgYen > 0 ? snapshot.income12mAvgYen : baseParams.monthlyIncome,
  postFireExtraExpense:
    Number(baseParams?.postFireExtraExpense ?? 0) + postFireExtraExpenseAdjustmentYen,
});

const dashboardProjectAtSnapshot_ = (snapshot, { baseParams, universityFundYen, sideFireAnnualIncomeYen }) => {
  const totalAssetsYen = Math.max(0, Number(snapshot?.totalAssetsYen ?? 0));
  const snapshotRiskAssetsYen = Math.max(0, Number(snapshot?.riskAssetsYen ?? 0));
  const fireTargetAssetsYen = Math.max(0, totalAssetsYen - universityFundYen);

  const toProjection = (reach) => ({
    ...reach,
    projectedMonth: reach.reached
      ? dashboardAddMonthsToMonthKey_(snapshot.month, reach.monthsToReach)
      : null,
  });

  const side = toProjection(
    dashboardEstimateReach_(
      dashboardBuildRetrospectiveParams_({
        snapshot,
        baseParams,
        initialAssetsYen: fireTargetAssetsYen,
        riskAssetsYen: Math.min(snapshotRiskAssetsYen, fireTargetAssetsYen),
        postFireExtraExpenseAdjustmentYen: -Math.round(sideFireAnnualIncomeYen / 12),
      }),
    ),
  );

  const full = toProjection(
    dashboardEstimateReach_(
      dashboardBuildRetrospectiveParams_({
        snapshot,
        baseParams,
        initialAssetsYen: totalAssetsYen,
        riskAssetsYen: Math.min(snapshotRiskAssetsYen, totalAssetsYen),
      }),
    ),
  );

  return { month: snapshot.month, fireTargetAssetsYen, side, full };
};

const dashboardProjectionDeltaMonths_ = (previous, latest) => {
  if (!previous || !latest) return null;
  if (previous.alreadyReached) return null;
  if (!previous.projectedMonth || !latest.projectedMonth) return null;
  return dashboardMonthKeyToIndex_(previous.projectedMonth) - dashboardMonthKeyToIndex_(latest.projectedMonth);
};

export function dashboardBuildProjectionTrend_(
  snapshots,
  {
    baseParams,
    universityFundYen = DASHBOARD_UNIVERSITY_FUND_YEN,
    sideFireAnnualIncomeYen = DASHBOARD_SIDE_FIRE_ANNUAL_INCOME_YEN,
  } = {},
) {
  const rows = (Array.isArray(snapshots) ? snapshots : [])
    .filter((row) => dashboardParseMonthKey_(row?.month))
    .sort((a, b) => a.month.localeCompare(b.month));
  const points = rows.map((row) =>
    dashboardProjectAtSnapshot_(row, { baseParams, universityFundYen, sideFireAnnualIncomeYen }),
  );
  const hasTrend = points.length >= 2;
  const previous = points[points.length - 2];
  const latest = points[points.length - 1];
  return {
    hasTrend,
    points,
    delta: {
      side: hasTrend ? dashboardProjectionDeltaMonths_(previous?.side, latest?.side) : null,
      full: hasTrend ? dashboardProjectionDeltaMonths_(previous?.full, latest?.full) : null,
    },
  };
}

// --- RSS item assembly: the home screen's view model and
// wording, as plain text (the /social highlights format: a
// compact summary, a separator, then the full detail lines). ---

const dashboardMonthLabel_ = (monthKey) => {
  if (!monthKey) return '';
  const [year, month] = monthKey.split('-');
  return `${year}年${Number(month)}月`;
};

const dashboardDateLabel_ = (dateKey) => {
  if (!dateKey) return '';
  const [, month, day] = dateKey.split('-').map(Number);
  return `${month}月${day}日`;
};

// Port of the simulator formatters: the calendar month
// `months` from now, and a duration label.
const dashboardFireDateLabel_ = (months, baseDate = new Date()) => {
  if (months >= 1200 || months < 0) return '未達成 (100年以上)';
  const date = new Date(baseDate);
  date.setMonth(date.getMonth() + months);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
};

const dashboardFormatMonths_ = (months) => {
  if (months >= 1200 || months < 0) return '100年以上';
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (years === 0) return `${remainingMonths}ヶ月`;
  return `${years}年${remainingMonths}ヶ月`;
};

// One dashboard item for the current slot, or null when the
// portfolio is missing. All five home blocks are included,
// with the screen's values and wording.
export function buildDashboardRssItem_(portfolio, nowMs) {
  if (!portfolio) {
    return null;
  }
  const slot = dashboardRssSlot_(nowMs);
  const todayKey = dashboardRssJstDateKey_(nowMs);
  const currentMonthKey = todayKey.slice(0, 7);
  const cashFlow = portfolio.cashFlow ?? [];
  const snapshots = portfolio.snapshots ?? [];

  const baseParams = dashboardBuildFireBaseParams_(portfolio);

  const investmentCard = dashboardBuildInvestmentCard_(cashFlow, currentMonthKey);
  const freshnessCard = dashboardBuildFreshnessCard_(cashFlow, todayKey);
  const review = dashboardBuildCashFlowReview_(cashFlow, currentMonthKey);
  const attention = dashboardBuildAttentionItems_({ investmentCard, freshnessCard, review });

  const assetDaily = {
    ...dashboardBuildAssetDailyChange_(portfolio.holdings),
    riskAssetsYen: dashboardRiskAssetsTotalYen_(portfolio.holdings),
  };
  const recentExpenses = dashboardBuildRecentExpenses_(cashFlow);

  const fireProgress = dashboardBuildFireProgress_({ portfolio, baseParams });
  const assetGoals = dashboardBuildAssetGoals_({
    portfolio,
    baseParams,
    startMonthKey: currentMonthKey,
  });
  const projectionTrend = dashboardBuildProjectionTrend_(snapshots, {
    baseParams,
    universityFundYen: DASHBOARD_UNIVERSITY_FUND_YEN,
    sideFireAnnualIncomeYen: DASHBOARD_SIDE_FIRE_ANNUAL_INCOME_YEN,
  });
  const full = fireProgress.full;
  const fireSummary = {
    progressRatePct: full.progressRate != null ? full.progressRate * 100 : null,
    requiredAssetsYen: full.requiredAssetsYen,
    gapYen: full.gapYen,
    alreadyReached: full.alreadyReached,
    reached: full.reached,
    durationLabel: full.reached ? dashboardFormatMonths_(full.monthsToReach) : null,
    dateLabel: full.reached ? dashboardFireDateLabel_(full.monthsToReach, new Date(nowMs)) : null,
    ageLabel: full.reached
      ? `${Math.floor(baseParams.currentAge + full.monthsToReach / 12)}歳`
      : null,
    deltaMonths: projectionTrend.delta.full,
    hasTrend: projectionTrend.hasTrend,
  };

  const headline = dashboardBuildHeadline_({
    snapshots,
    currentNetAssetsYen: portfolio.totals?.netWorthYen ?? 0,
    projectionDeltaMonths: projectionTrend.delta.full,
  });

  // Compact summary for the reader card, in priority order.
  const segments = [];
  if (headline.hasComparison) {
    let segment =
      '純資産 ' + dashboardFormatYen_(headline.netAssetsYen) + '（先月比 ' + dashboardFormatSignedYen_(headline.diffYen);
    if (headline.diffRatePct != null) {
      segment += '・' + dashboardFormatSignedPercent_(headline.diffRatePct, 1);
    }
    segments.push(segment + '）');
  } else {
    segments.push('純資産 ' + dashboardFormatYen_(headline.netAssetsYen));
  }
  if (assetDaily.hasData) {
    let segment = '前日比 ' + dashboardFormatSignedYen_(assetDaily.totalDailyChangeYen);
    if (assetDaily.totalChangeRatePct != null) {
      segment += '（' + dashboardFormatSignedPercent_(assetDaily.totalChangeRatePct, 1) + '）';
    }
    segments.push(segment);
  }
  segments.push(attention.items.length ? '要確認' + attention.totalCount + '件' : '要確認なし');
  if (recentExpenses.hasData) {
    segments.push('過去3日 ' + dashboardFormatYen_(recentExpenses.totalYen));
  }
  if (fireSummary.progressRatePct != null) {
    segments.push('FIRE到達率 ' + fireSummary.progressRatePct.toFixed(1) + '%');
  }
  let summary = '';
  segments.forEach((segment) => {
    const next = summary ? summary + ' / ' + segment : segment;
    if (next.length <= DASHBOARD_RSS_SUMMARY_CHARS) {
      summary = next;
    }
  });

  // Detail lines, mirroring the home screen block by block.
  // Section titles use the same bracketed style as the screen's
  // section headings (brackets built from char codes).
  const sectionTitle = (title) => String.fromCharCode(12304) + title + String.fromCharCode(12305);
  const lines = [];

  lines.push(sectionTitle('今月の結論'));
  if (headline.hasComparison) {
    let line =
      '純資産は ' +
      dashboardFormatYen_(headline.netAssetsYen) +
      '（' +
      dashboardMonthLabel_(headline.month) +
      '末・先月比 ' +
      dashboardFormatSignedYen_(headline.diffYen);
    if (headline.diffRatePct != null) {
      line += '（' + dashboardFormatSignedPercent_(headline.diffRatePct, 1) + '）';
    }
    line += '）';
    if (headline.pace === 'improving') {
      line += '。完全FIREの到達見込みは先月より' + headline.projectionDeltaMonths + 'か月近づきました。';
    } else if (headline.pace === 'worsening') {
      line += '。完全FIREの到達見込みは先月より' + -headline.projectionDeltaMonths + 'か月遠のきました。';
    } else if (headline.pace === 'steady') {
      line += '。完全FIREの到達見込みは先月から変わりません。';
    }
    lines.push(line);
  } else {
    lines.push(
      '現在の純資産は ' +
        dashboardFormatYen_(headline.netAssetsYen) +
        ' です。先月比は来月から表示されます（月末スナップショットが2か月分たまると表示されます）。',
    );
  }

  lines.push(sectionTitle('資産推移'));
  if (assetDaily.hasData) {
    let line = 'リスク資産は前日比 ' + dashboardFormatSignedYen_(assetDaily.totalDailyChangeYen);
    if (assetDaily.totalChangeRatePct != null) {
      line += '（' + dashboardFormatSignedPercent_(assetDaily.totalChangeRatePct, 1) + '）';
    }
    line += '（現在 ' + dashboardFormatYen_(assetDaily.riskAssetsYen) + '）';
    lines.push(line);
    lines.push('前日比への寄与が大きい銘柄：');
    assetDaily.contributors.forEach((contributor) => {
      let contributorLine = '・' + contributor.name + ' ' + dashboardFormatSignedYen_(contributor.changeYen);
      if (contributor.changeRatePct != null) {
        contributorLine += '（' + dashboardFormatSignedPercent_(contributor.changeRatePct, 1) + '）';
      }
      lines.push(contributorLine);
    });
    if (assetDaily.rowsWithData < assetDaily.rowsTotal) {
      lines.push(
        '※ 前日比は、値がある ' + assetDaily.rowsWithData + '／' + assetDaily.rowsTotal + ' 銘柄分だけを集計しています。',
      );
    }
  } else {
    lines.push('前日比のデータがありません（リスク資産は現在 ' + dashboardFormatYen_(assetDaily.riskAssetsYen) + '）。');
  }

  lines.push(sectionTitle('要確認'));
  if (attention.items.length) {
    attention.items.forEach((item) => {
      if (item.kind === 'freshness') {
        lines.push(
          '・明細の取り込みが止まっています' +
            (item.latestDate
              ? '（最新は ' + item.latestDate + ' 分・' + item.ageDays + '日前）'
              : '（明細データがありません）'),
        );
      } else if (item.kind === 'investment') {
        lines.push(
          '・先月（' +
            dashboardMonthLabel_(item.month) +
            '）の投資実行額が基準未満でした（' +
            dashboardFormatYen_(item.amountYen) +
            '／基準 ' +
            dashboardFormatYen_(item.standardYen) +
            '・判定は本人分のみ）',
        );
      } else if (item.kind === 'category') {
        let line =
          '・' +
          item.label +
          'が12か月平均を大きく上回りました（先月 ' +
          dashboardFormatYen_(item.monthYen) +
          '／平均 ' +
          dashboardFormatYen_(item.averageYen);
        if (item.ratioPct != null) {
          line += '・+' + item.ratioPct + '%';
        }
        lines.push(line + '）');
        item.topExpenses.forEach((expense) => {
          lines.push(
            '　- ' + dashboardDateLabel_(expense.date) + ' ' + expense.name + ' ' + dashboardFormatYen_(expense.amountYen),
          );
        });
      } else if (item.kind === 'living-cost') {
        lines.push(
          '・生活費が12か月平均の+10%を超えました（先月 ' +
            dashboardFormatYen_(item.amountYen) +
            '／平均 ' +
            dashboardFormatYen_(item.averageYen) +
            '）',
        );
      } else if (item.kind === 'special') {
        lines.push(
          '・先月に大きな特別支出がありました（' + item.name + ' ' + dashboardFormatYen_(item.amountYen) + '）',
        );
      }
    });
    if (attention.totalCount > attention.items.length) {
      lines.push('ほか' + (attention.totalCount - attention.items.length) + '件あります。詳細は収支画面で確認できます。');
    }
  } else {
    lines.push('要確認はありません。');
  }

  lines.push(sectionTitle('過去3日間の支出'));
  if (recentExpenses.hasData) {
    lines.push(
      dashboardDateLabel_(recentExpenses.fromDate) +
        '〜' +
        dashboardDateLabel_(recentExpenses.latestDate) +
        'の支出（明細の最新日を末日にしています）。合計 ' +
        dashboardFormatYen_(recentExpenses.totalYen),
    );
    recentExpenses.groups.forEach((group) => {
      lines.push(dashboardDateLabel_(group.date) + '（' + dashboardFormatYen_(group.totalYen) + '）');
      group.items.forEach((expense) => {
        lines.push(
          '・' + expense.name + (expense.category ? ' ' + expense.category : '') + ' ' + dashboardFormatYen_(expense.amountYen),
        );
      });
    });
  } else {
    lines.push('過去3日間の支出は記録されていません。');
  }

  lines.push(sectionTitle('FIRE進捗の要点（完全FIRE）'));
  lines.push(
    '到達率 ' +
      (fireSummary.progressRatePct != null ? fireSummary.progressRatePct.toFixed(1) + '%' : '—') +
      '（総資産 ÷ 必要資産）',
  );
  let fireLine = '';
  if (fireSummary.alreadyReached) {
    fireLine = '現在の前提では、すでに到達可能な水準です。';
  } else if (fireSummary.reached) {
    fireLine =
      '到達見込みは ' +
      fireSummary.dateLabel +
      '（' +
      fireSummary.ageLabel +
      '時点・あと' +
      fireSummary.durationLabel +
      '）。必要資産 ' +
      dashboardFormatYen_(fireSummary.requiredAssetsYen) +
      '、あと ' +
      dashboardFormatYen_(fireSummary.gapYen) +
      ' です。';
  } else {
    fireLine = '現在の前提では到達見込みが立ちません。';
  }
  if (fireSummary.hasTrend && fireSummary.deltaMonths != null) {
    if (fireSummary.deltaMonths > 0) {
      fireLine += '先月より見込みが' + fireSummary.deltaMonths + 'か月近づきました。';
    } else if (fireSummary.deltaMonths < 0) {
      fireLine += '先月より見込みが' + -fireSummary.deltaMonths + 'か月遠のきました。';
    } else {
      fireLine += '先月から見込みは変わりません。';
    }
  }
  lines.push(fireLine);

  const goalLine = (label, goal) => {
    const rate = goal.progressRate != null ? (goal.progressRate * 100).toFixed(1) + '%' : '—';
    if (goal.alreadyReached) {
      return label + '：達成度 ' + rate + '・達成済みです。';
    }
    if (goal.reached) {
      const [year, month] = goal.projectedMonth.split('-').map(Number);
      return (
        label +
        '：達成度 ' +
        rate +
        '・達成見込みは ' +
        year +
        '年' +
        month +
        '月（あと' +
        dashboardFormatMonths_(goal.monthsToReach) +
        '）です。'
      );
    }
    return label + '：達成度 ' + rate + '・現在の前提では見込みが立ちません。';
  };
  lines.push(goalLine('金融資産1億円', assetGoals.total));
  lines.push(goalLine('純金融資産1億円', assetGoals.net));

  const dateParts = slot.dateKey.split('-');
  return {
    title: Number(dateParts[1]) + '月' + Number(dateParts[2]) + '日 資産ダッシュボード',
    guid: 'asset-dashboard-' + slot.dateKey,
    pubDate: new Date(slot.atMs).toUTCString(),
    descriptionText:
      summary + '\n-------\n' + lines.join('\n') + '\n詳しくは ' + DASHBOARD_RSS_CHANNEL.link,
  };
}
