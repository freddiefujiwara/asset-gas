const FOLDER_ID = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';
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


export function preCacheAll() {
  const cache = CacheService.getScriptCache();
  const allEntries = getAllCsvDataEntries_();
  const allData = entriesToObject_(allEntries);
  const cacheKeys = ['0', ...allEntries.map((entry) => entry.typeName)];

  cache.removeAll(cacheKeys);
  cache.put('0', JSON.stringify(allData), MAX_CACHE_DURATION_SECONDS);

  allEntries.forEach((entry) => {
    cache.put(entry.typeName, JSON.stringify(entry.data), MAX_CACHE_DURATION_SECONDS);
  });

  return {
    status: true,
    cachedKeys: cacheKeys,
  };
}

export function doGet(e) {
  try {
    if (!isDebugMode_()) {
      const idToken = extractBearerToken_(e);
      verifyGoogleIdTokenOrThrow_(idToken);
    }

    const parameters = e?.parameter;

    if (parameters?.t) {
      const cachedData = getCacheValue_(parameters.t);
      if (cachedData !== null) {
        return createJsonResponse_(cachedData);
      }

      return createJsonResponse_(convertCsvToJsonInFolder(parameters.t));
    }

    if (isEmptyParameters_(parameters)) {
      const cachedAllData = getCacheValue_('0');
      if (cachedAllData !== null) {
        return createJsonResponse_(cachedAllData);
      }

      const allData = getAllCsvDataInFolder_();
      return createJsonResponse_(JSON.stringify(allData));
    }

    return createJsonResponse_(JSON.stringify({ status: true }));
  } catch (error) {
    const message = error?.message || 'unauthorized';
    const status = message === 'forbidden email' ? 403 : 401;
    return createJsonResponse_(JSON.stringify({ status, error: message }));
  }
}

export function convertCsvToJsonInFolder(typeName) {
  const targetName = toCsvFileName_(typeName);
  const csvFile = findCsvFileByName_(targetName);

  if (!csvFile) {
    return JSON.stringify({ error: `File not found: ${typeName}` });
  }

  const csvContent = csvFile.getBlob().getDataAsString('UTF-8');
  const parsedRows = parseCsv_(csvContent);
  const formattedRows = applyFormattingRules(parsedRows, typeName);

  return JSON.stringify(formattedRows);
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

function getMimeTypes_() {
  return {
    csv: MimeType.CSV,
    json: ContentService.MimeType.JSON,
  };
}

function createJsonResponse_(jsonString) {
  return ContentService
    .createTextOutput(jsonString)
    .setMimeType(getMimeTypes_().json);
}

function isEmptyParameters_(parameters) {
  if (!parameters) {
    return true;
  }

  return Object.keys(parameters).length === 0;
}

function getCsvFilesIterator_() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  return folder.getFilesByType(getMimeTypes_().csv);
}

function getAllCsvDataInFolder_() {
  const allEntries = getAllCsvDataEntries_();
  return entriesToObject_(allEntries);
}

function getAllCsvDataEntries_() {
  const files = getCsvFilesIterator_();
  const entries = [];

  while (files.hasNext()) {
    const file = files.next();
    const typeName = removeCsvExtension_(file.getName());
    const csvContent = file.getBlob().getDataAsString('UTF-8');
    const parsedRows = parseCsv_(csvContent);
    entries.push({
      typeName,
      data: applyFormattingRules(parsedRows, typeName),
    });
  }

  return entries;
}

function entriesToObject_(entries) {
  return entries.reduce((acc, entry) => {
    acc[entry.typeName] = entry.data;
    return acc;
  }, {});
}

function findCsvFileByName_(targetFileNameLowerCase) {
  const files = getCsvFilesIterator_();

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().toLowerCase() === targetFileNameLowerCase) {
      return file;
    }
  }

  return null;
}

function removeCsvExtension_(fileName) {
  return fileName.replace(/\.csv$/i, '');
}

function toCsvFileName_(typeName) {
  return `${typeName}.csv`.toLowerCase();
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

function extractBearerToken_(event) {
  const headers = event?.headers || {};
  const auth = headers.Authorization || headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
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
