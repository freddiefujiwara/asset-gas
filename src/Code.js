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
      const jsonContent = parseCsv_(csvData);
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
