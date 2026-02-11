export function doGet(e) {
  const folderId = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';

  if (e && e.parameter && e.parameter.t) {
    const jsonString = convertCsvToJsonInFolder(e.parameter.t);
    return ContentService
      .createTextOutput(jsonString)
      .setMimeType(ContentService.MimeType.JSON);
  }

  if (!e || !e.parameter || Object.keys(e.parameter).length === 0) {
    const folder = DriveApp.getFolderById(folderId);
    const files = folder.getFilesByType(MimeType.CSV);
    const fileList = [];
    while (files.hasNext()) {
      const file = files.next();
      const fileName = file.getName();
      // Remove .csv extension (case-insensitive)
      const nameWithoutExtension = fileName.replace(/\.csv$/i, '');
      fileList.push(nameWithoutExtension);
    }
    return ContentService
      .createTextOutput(JSON.stringify(fileList))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ status: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

export function convertCsvToJsonInFolder(typeName) {
  const folderId = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByType(MimeType.CSV);
  const targetName = (typeName + '.csv').toLowerCase();

  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().toLowerCase() === targetName) {
      const csvData = file.getBlob().getDataAsString('UTF-8');
      let jsonContent = parseCsv_(csvData);
      jsonContent = applyFormattingRules(jsonContent, typeName);
      return JSON.stringify(jsonContent);
    }
  }

  return JSON.stringify({ error: 'File not found: ' + typeName });
}

/**
 * CSV文字列をJSON配列に変換する補助関数
 */
export function parseCsv_(csvString) {
  const values = Utilities.parseCsv(csvString);
  if (values.length < 2) return [];

  const headers = values[0];
  const rows = values.slice(1);

  return rows.map(row => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

/**
 * tの値に基づいてデータを整形する
 */
export function applyFormattingRules(data, typeName) {
  if (!Array.isArray(data)) return data;

  return data.map(item => {
    const newItem = { ...item };

    if (typeName === 'breakdown-liability') {
      delete newItem['timestamp'];
      delete newItem['amount_text_num'];
      delete newItem['percentage_text_num'];
    } else if (typeName.startsWith('details__liability')) {
      delete newItem['timestamp'];
      delete newItem['detail_id'];
      delete newItem['table_index'];
      delete newItem['残高_yen'];
    } else if (typeName === 'total-liability') {
      delete newItem['timestamp'];
      delete newItem['total_text_num'];
    } else if (typeName === 'assetClassRatio') {
      delete newItem['timestamp'];
      if (newItem.hasOwnProperty('y')) {
        newItem['amount_yen'] = newItem['y'];
        delete newItem['y'];
      }
    } else if (typeName.startsWith('details__portfolio')) {
      delete newItem['timestamp'];
      delete newItem['detail_id'];
      delete newItem['table_index'];
    }

    return newItem;
  });
}
