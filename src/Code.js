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
  const xmlData = getAllXmlDataEntries_();
  const cacheKeys = ['0', 'mfcf'];

  cache.removeAll(cacheKeys);
  cache.put('0', JSON.stringify(allData), MAX_CACHE_DURATION_SECONDS);
  cache.put('mfcf', JSON.stringify(xmlData), MAX_CACHE_DURATION_SECONDS);

  return {
    status: true,
    cachedKeys: cacheKeys,
  };
}

export function doGet(e) {
  try {
    const parameters = e?.parameter;

    if (parameters?.f === 'preCacheAll') {
      return createJsonResponse_(JSON.stringify(preCacheAll()));
    }

    if (!isDebugMode_()) {
      const idToken = extractIdToken_(e);
      verifyGoogleIdTokenOrThrow_(idToken);
    }

    if (isEmptyParameters_(parameters)) {
      const cachedCsvData = getCacheValue_('0');
      const cachedXmlData = getCacheValue_('mfcf');

      if (cachedCsvData !== null && cachedXmlData !== null) {
        const allData = JSON.parse(cachedCsvData);
        allData['mfcf'] = JSON.parse(cachedXmlData);
        return createJsonResponse_(JSON.stringify(allData));
      }

      const allData = getAllCsvDataInFolder_();
      allData['mfcf'] = getAllXmlDataEntries_();
      return createJsonResponse_(JSON.stringify(allData));
    }

    return createJsonResponse_(JSON.stringify({ status: true }));
  } catch (error) {
    const message = error?.message || 'unauthorized';
    const status = message === 'forbidden email' ? 403 : 401;
    return createJsonResponse_(JSON.stringify({ status, error: message }));
  }
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

  const keys = Object.keys(parameters).filter((key) => key !== 'id_token');
  return keys.length === 0;
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

function removeCsvExtension_(fileName) {
  return fileName.replace(/\.csv$/i, '');
}

/**
 * mfcf.YYYYMM.xmlファイルを読み込み、全データを結合して返す
 */
export function getAllXmlDataEntries_() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const files = folder.getFiles();
  const xmlFiles = [];
  const regex = /^mfcf\.(\d{6})\.xml$/;

  while (files.hasNext()) {
    const file = files.next();
    const fileName = file.getName();
    const match = fileName.match(regex);
    if (match) {
      xmlFiles.push({
        file: file,
        yyyymm: parseInt(match[1], 10),
      });
    }
  }

  // YYYYMMが大きい順（新しい順）にソート
  xmlFiles.sort((a, b) => b.yyyymm - a.yyyymm);

  let allEntries = [];
  xmlFiles.forEach((item) => {
    try {
      const xmlContent = item.file.getBlob().getDataAsString('UTF-8');
      const entries = parseMfcfXml_(xmlContent);
      allEntries = allEntries.concat(entries);
    } catch (e) {
      Logger.log(`Failed to process file ${item.file.getName()}: ${e.message}`);
    }
  });

  return allEntries;
}

/**
 * XML(RSS 2.0)をパースしてオブジェクトの配列に変換する
 */
function parseMfcfXml_(xmlContent) {
  const document = XmlService.parse(xmlContent);
  const root = document.getRootElement();
  const channel = root.getChild('channel');
  if (!channel) return [];

  const items = channel.getChildren('item');

  return items.map((item) => {
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
      date: formatDate_(pubDate),
      amount,
      currency: 'JPY',
      name,
      category,
      is_transfer,
    };
  });
}

/**
 * pubDateをYYYY-MM-DD形式に変換する
 */
function formatDate_(pubDate) {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (e) {
    return '';
  }
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
