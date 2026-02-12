# CSV to JSON API

This project is a Google Apps Script that converts CSV files to JSON.
The CSV files are stored in a specific Google Drive folder.

## How to use the API

You can use the API by sending a GET request to the Web App URL.

### 1. Get a list of files
If you do not provide any parameters, the API returns a list of all CSV file names in the folder.

Example:
`https://script.google.com/macros/s/.../exec`

### 2. Get file content
If you provide the `t` parameter with a file name (without `.csv`), the API returns the content of that file as JSON.

Example:
`https://script.google.com/macros/s/.../exec?t=total-liability`

The API also cleans up the data based on the file name (for example, it removes timestamps or renames fields).

## For Developers

### Setup
1. Install dependencies:
   ```bash
   npm install
   ```

### Commands
- **Test**: Run tests to make sure everything works correctly.
  ```bash
  npm test
  ```
- **Build**: Prepare the code for Google Apps Script.
  ```bash
  npm run build
  ```
- **Deploy**: Build and push the code to your Google Apps Script project.
  ```bash
  npm run deploy
  ```

### Scope changes (`AUTH 401` for `UrlFetchApp.fetch`)
If you add or change `oauthScopes` in `appsscript.json` (for example `https://www.googleapis.com/auth/script.external_request`),
`clasp push` alone is not enough for an already published Web App deployment.

After `npm run deploy`, run:

```bash
clasp version "update scopes"
clasp deploy --deploymentId <your-webapp-deployment-id>
```

Then re-authorize once with the **deploying account** (because this project uses `executeAs: USER_DEPLOYING`).
