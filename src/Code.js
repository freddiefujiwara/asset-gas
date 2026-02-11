export function doGet(e) {
  const folderId = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';

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

export function convertCsvToJsonInFolder() {
  // 1. フォルダIDを指定（フォルダのURLの末尾の部分）
  const folderId = '19PDxxar-38XMlBiYC02lDb1bJh3wJRkh';
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByType(MimeType.CSV);

  let allData = {};

  while (files.hasNext()) {
    const file = files.next();
    const csvData = file.getBlob().getDataAsString('UTF-8'); // 文字コードに合わせて変更
    const jsonContent = parseCsv_(csvData);
    // ファイル名をキーにして保存
    allData[file.getName()] = jsonContent;
  }

  // 2. 結果をログに出力（またはファイルとして保存）
  const jsonString = JSON.stringify(allData, null, 2);
  console.log(jsonString);
  // 必要であれば、新しいJSONファイルとして保存
  // folder.createFile('output.json', jsonString, MimeType.PLAIN_TEXT);
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
