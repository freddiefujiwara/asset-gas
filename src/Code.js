const FOLDER_ID = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';

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

export function doGet(e) {
  const parameters = e?.parameter;

  if (parameters?.t) {
    return createJsonResponse_(convertCsvToJsonInFolder(parameters.t));
  }

  if (isEmptyParameters_(parameters)) {
    const fileNames = listCsvFileNamesWithoutExtension_();
    return createJsonResponse_(JSON.stringify(fileNames));
  }

  return createJsonResponse_(JSON.stringify({ status: true }));
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

function listCsvFileNamesWithoutExtension_() {
  const files = getCsvFilesIterator_();
  const fileNames = [];

  while (files.hasNext()) {
    const file = files.next();
    fileNames.push(removeCsvExtension_(file.getName()));
  }

  return fileNames;
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
