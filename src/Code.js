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

const findShareFile_ = () => findSessionFile_(SHARE_FILE_NAME);

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

const issueSession_ = (fileName, tokenKey) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + SHARE_TTL_SECONDS * 1000).toISOString();
  const records = readSessionRecords_(fileName);
  revokeActiveSessions_(records, nowIso);
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
// later calls. Issuing a new one revokes the previous ones, and the
// frontend revokes its session on logout.

const OWNER_FILE_NAME = 'asset-owner-sessions.json';

const issueOwnerSession_ = () => issueSession_(OWNER_FILE_NAME, 'session_token');

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

    if (parameters?.f === 'preCacheAll') {
      return createJsonResponse_(JSON.stringify(preCacheAll()));
    }

    let shareSession = null;

    if (!isDebugMode_()) {
      const action = parameters?.action;

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

function isDebugMode_() {
  return getScriptProperty_('DEBUG') === 'true';
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
