# asset-gas Technical Specification (Very Detailed)

This document is a full technical specification for this repository.
It is written in very simple English.
The goal is: a new engineer can understand the full behavior without reading the source code.

---

## 1. Project Overview

### 1.1 Background

This project is a **Google Apps Script Web API**.
It reads data files from one Google Drive folder and returns one JSON response.

The data source has 2 file families:

1. **CSV files** (general portfolio and liability data)
2. **XML files** named like `mfcf.YYYYMM.xml` (cash-flow / transaction feed in RSS-style XML)

The API is published as a Google Apps Script Web App.
Consumers can call it with HTTP `GET`.

### 1.2 Purpose

The purpose is to provide a single endpoint that:

- converts many CSV files to JSON arrays,
- applies file-specific cleanup / normalization rules,
- parses XML transaction files into normalized objects,
- and can return cached data for fast response.

### 1.3 Problems Solved

This project solves these practical problems:

- **Data format fragmentation**: source files are split across many CSV and XML files.
- **Raw data noise**: some CSV fields are temporary/internal and should be removed.
- **Inconsistent naming**: e.g., one file has `y` but consumers want `amount_yen`.
- **Date inconsistency in XML feed**: transaction date can appear in title, description, or pubDate.
- **Performance pressure**: reading many Drive files on every request is expensive.
- **Access control requirement**: API should only allow specific Google accounts (except debug mode).

---

## 2. System Architecture

### 2.1 Runtime

- Platform: **Google Apps Script** (`V8` runtime)
- API style: single `doGet(e)` entrypoint
- Transport: HTTPS GET (Web App URL)
- Response format: JSON text response with JSON MIME type

### 2.2 Main Components

1. **HTTP Handler**
   - `doGet(e)` routes incoming GET requests.
2. **Authentication Layer**
   - Verifies Google ID token with Google tokeninfo endpoint.
   - Checks issuer, audience, expiry, email verification, and allow-list membership.
3. **CSV Pipeline**
   - Reads all CSV files in target folder.
   - Parses CSV rows.
   - Applies rule-based field cleanup per file type.
4. **XML Pipeline**
   - Finds `mfcf.YYYYMM.xml` files.
   - Sorts by month descending.
   - Parses RSS items to normalized transaction objects.
5. **Cache Layer**
   - Uses script cache for full API payload pieces.
   - Supports pre-warming by special function parameter.
6. **Build/Deploy Tooling**
   - Node.js script strips `export` statements for Apps Script deployment.
   - `clasp` push-based deployment flow.

### 2.3 Data Flow (Normal Request)

1. Client sends `GET /exec`.
2. If not debug mode, ID token is extracted and verified.
3. If no functional query params (except optional `id_token`):
   - Try to load full response from cache keys.
   - If cache incomplete/invalid, load live data from Drive.
4. Return JSON object with:
   - each CSV file as one key, and
   - `mfcf` key containing merged XML entries.

---

## 3. API Specification

## 3.1 Endpoint

- Method: `GET`
- Path: `/exec`
- Host: deployed Google Apps Script Web App URL

(An OpenAPI document exists in `openapi.yaml`.)

## 3.2 Query Parameters

- `f` (optional)
  - Supported value: `preCacheAll`
  - If set, API runs cache pre-warm logic and returns status.
- `id_token` (optional in query)
  - Google ID token.
  - Can also be provided in `Authorization: Bearer <token>` header.

## 3.3 Authentication Behavior

By default, authentication is **required**.

Authentication is skipped only if script property `DEBUG=true`.

When required, token verification must pass all checks:

1. token exists
2. `GOOGLE_OAUTH_CLIENT_ID` script property exists
3. Google tokeninfo returns HTTP 200
4. `iss` is `accounts.google.com` or `https://accounts.google.com`
5. `aud` equals configured OAuth client ID
6. `exp` is in the future
7. `email_verified` is true
8. email exists and is in comma-separated allow-list from `AVAILABLE_GMAILS`

## 3.4 Response Patterns

### A) Default data fetch (no functional params)

Response is a JSON object:

- CSV file data: dynamic keys based on CSV filename (without `.csv`)
- `mfcf`: array of normalized XML transaction objects

### B) Cache warm request (`f=preCacheAll`)

Returns:

```json
{
  "status": true,
  "cachedKeys": ["0", "mfcf", "mfcf.202602", "mfcf.202601"]
}
```

(Example keys. Actual month keys depend on existing files.)

### C) Other query params

Returns:

```json
{ "status": true }
```

### D) Auth / verification failure

Returns JSON error object:

```json
{ "status": 401, "error": "<message>" }
```

Special case:

- if error message is exactly `forbidden email`, status is `403`.

---

## 4. Detailed Functional Specification

## 4.1 File Discovery

### 4.1.1 CSV files

- Folder is identified by a fixed folder ID constant.
- Only files with CSV MIME type are iterated.
- File basename without `.csv` becomes output key.

### 4.1.2 XML files

- All files in folder are scanned.
- Only names matching `^mfcf\.(\d{6})\.xml$` are accepted.
- Captured `YYYYMM` is used for sorting and cache key naming.
- Files are processed newest month first (`YYYYMM` descending numeric order).

## 4.2 CSV Parsing and Mapping

Input: raw CSV text.

Process:

1. Parse with `Utilities.parseCsv`.
2. If row count < 2, return empty array.
3. First row = headers.
4. For each next row, map `headers[i] -> row[i]`.

Output: array of plain objects.

Notes:

- Values are strings as returned by CSV parser.
- Missing cells map to `undefined`.
- Extra cells beyond headers are ignored.

## 4.3 CSV Formatting Rules

Rules are selected by output key (`typeName` from filename).
Exactly one first-matching rule is applied.
If no rule matches, data is returned unchanged (cloned object per row).

### Rule group 1

Match: `breakdown-liability` or `breakdown`

Remove fields:

- `timestamp`
- `amount_text_num`
- `percentage_text_num`

### Rule group 2

Match: key starts with `details__liability`

Remove fields:

- `timestamp`
- `detail_id`
- `table_index`
- `残高_yen`

### Rule group 3

Match: `total-liability`

Remove fields:

- `timestamp`
- `total_text_num`

### Rule group 4

Match: `assetClassRatio`

Remove fields:

- `timestamp`

Transform:

- if field `y` exists, rename it to `amount_yen`

### Rule group 5

Match: key starts with `details__portfolio`

Remove fields:

- `timestamp`
- `detail_id`
- `table_index`

## 4.4 XML Parsing (mfcf)

Each XML file is expected to be RSS 2.0 style:

- `<rss><channel><item>...</item></channel></rss>`

Each `<item>` produces one output object:

- `date` (normalized `YYYY-MM-DD` or empty string)
- `amount` (integer, yen sign/comma removed)
- `currency` (always `JPY`)
- `name` (derived from title)
- `category` (from description segment)
- `is_transfer` (boolean, default false)

### 4.4.1 Amount and Name extraction

Expected title pattern example:

- `02/12(木) -¥3,000 DF.トウキユウカ-ド`

Regex extracts:

- amount text: `-¥3,000`
- name: `DF.トウキユウカ-ド`

If regex does not match:

- amount defaults to 0
- name becomes full title text

### 4.4.2 Category and Transfer extraction

From description text, parser attempts:

- `category: ... is_transfer:` block for category
- `is_transfer: true|false` for transfer flag

Fallbacks:

- category: empty string
- is_transfer: `false`

### 4.4.3 Date selection priority

Date candidate is selected in this order:

1. `pubDate` if it already has explicit year (`YYYY/MM/DD` or `YYYY-MM-DD`)
2. `date:` token found in description
3. date-like prefix in title
4. raw `pubDate` as last fallback

Then normalized by formatter.

### 4.4.4 Date normalization rules

Given chosen date text and file month tag (`YYYYMM`):

1. If explicit `YYYY/MM/DD` or `YYYY-MM-DD` exists, keep that year.
2. Else if `MM/DD` style and no year:
   - use year extracted from file tag (`YYYYMM` -> `YYYY`),
   - if missing, use current system year.
3. Else try `new Date(text)` parse.
4. If invalid parse, return empty string.

All successful outputs are returned as `YYYY-MM-DD`.

## 4.5 Cache Design

Script cache keys:

- `0`: all CSV object data
- `mfcf`: JSON array of month keys (e.g., `mfcf.202602`)
- `mfcf.<YYYYMM>`: XML entries for each month file

TTL:

- `21600` seconds (6 hours)

### 4.5.1 Pre-cache behavior (`preCacheAll`)

1. Read old `mfcf` key, parse as list, try deleting old month keys.
2. Build fresh CSV map and XML-by-month arrays from live Drive.
3. Remove top-level keys `0` and `mfcf`.
4. Write fresh `0`, `mfcf`, and each month key.
5. Return cached key list.

### 4.5.2 Read path cache behavior

On default request:

1. Read `0` and `mfcf`.
2. If both exist, parse JSON.
3. Iterate all month keys from `mfcf`, reading each month cache.
4. If every month key exists and parses:
   - concatenate month arrays into one `mfcf` array
   - return merged cached response.
5. If any miss/parse error occurs:
   - ignore cache and rebuild live from Drive.

---

## 5. Exception Handling and Edge Cases

## 5.1 HTTP-level failures

`doGet` wraps entire flow in try/catch.

- Any thrown error returns JSON error payload.
- Status code is represented in JSON body (`401` or `403`), not as HTTP status setting.

## 5.2 Authentication edge cases

- Missing token -> `missing id token`
- Missing OAuth client ID property -> `missing GOOGLE_OAUTH_CLIENT_ID`
- Google verification non-200 -> `token verification failed`
- Invalid issuer/audience/expiry/email checks -> specific messages
- Email not in allow list -> `forbidden email` (mapped to status 403)

## 5.3 Cache edge cases

- Cache service unavailable: helper returns `null`, flow falls back to live data.
- Corrupt JSON in cache: parsing exceptions are swallowed and live load is used.
- Missing one monthly key: full cache is considered incomplete.

## 5.4 CSV edge cases

- Header-only or empty CSV -> empty array.
- Unknown filename type -> no formatting rule; row objects returned as-is.
- Input not array in formatter -> returned unchanged.

## 5.5 XML edge cases

- Non-matching filenames ignored.
- File read or parse failure per month -> month contributes empty list, processing continues.
- Missing `<channel>` -> empty list.
- Missing fields in `<item>` -> safe defaults.
- Unparseable date -> empty date string.

---

## 6. Algorithm Explanation (Step-by-Step)

## 6.1 Main Request Algorithm (`doGet`)

1. Read query params from event.
2. If `f=preCacheAll`, execute cache warm and return.
3. If not debug mode, perform token verification pipeline.
4. If request has no functional params:
   1. Try full cache hydration.
   2. If success, return cached merged object.
   3. Else read live CSV+XML and return.
5. For non-empty unrelated params, return `{status:true}`.
6. On any error, map to 401/403 JSON error.

Time complexity (default, live path):

- `O(C + X + R)` roughly, where
  - `C` = number of CSV files + rows processed,
  - `X` = number of XML files,
  - `R` = total XML items.

Cache-hit path is lower and mostly linear to total cached month entries.

## 6.2 XML Date Resolution Algorithm

For each XML item:

1. Build candidate from pubDate/description/title by priority.
2. Normalize by explicit-year rule.
3. If only MM/DD, inject file year.
4. Else use JS Date parse.
5. If parse fails, return empty.

This deterministic priority reduces wrong-year errors in month exports.

## 6.3 CSV Formatting Algorithm

For each data row object:

1. Clone object.
2. Find first matching formatting rule by type name.
3. Remove listed keys.
4. Apply optional transform (e.g., `y -> amount_yen`).
5. Return transformed clone.

Time complexity:

- Let `n` = rows, `k` = rule count.
- Rule selection is O(k) per file; row transform is O(n * removed_keys).
- With fixed small `k`, effectively linear in row count.

---

## 7. Data Structures

## 7.1 Core Response Structure

Top-level JSON object:

```json
{
  "<csv_type_name>": [
    { "columnA": "...", "columnB": "..." }
  ],
  "mfcf": [
    {
      "date": "2026-02-12",
      "amount": -3000,
      "currency": "JPY",
      "name": "DF.トウキユウカ-ド",
      "category": "現金・カード/カード引き落とし",
      "is_transfer": false
    }
  ]
}
```

`<csv_type_name>` is dynamic from filename.

## 7.2 Internal Entry Models

### CSV temporary entry

```ts
{
  typeName: string,
  data: Array<Record<string, string | undefined>>
}
```

### XML monthly cache entry

```ts
{
  key: string,           // e.g., mfcf.202602
  entries: MfcfEntry[]
}
```

### MfcfEntry

```ts
{
  date: string,
  amount: number,
  currency: 'JPY',
  name: string,
  category: string,
  is_transfer: boolean
}
```

## 7.3 Persistent/External Data Storage

There is no database in this repo.
External stores are:

1. Google Drive folder files (source of truth)
2. Apps Script Script Cache (ephemeral cache)
3. Apps Script Script Properties (config/env-like values)

---

## 8. Technology Choices and Rationale

## 8.1 Google Apps Script

Why chosen:

- Native integration with Google Drive APIs.
- Easy web app publishing.
- Good fit for lightweight internal API automation.

Trade-off:

- Runtime/platform limits compared to full server frameworks.

## 8.2 Plain JavaScript (ES modules in source)

Why chosen:

- Simple codebase.
- Easy unit testing in Node-like environment.
- Build step strips `export` for Apps Script compatibility.

## 8.3 Vitest for tests

Why chosen:

- Fast test runner.
- Good mocking for Apps Script globals (`DriveApp`, `CacheService`, etc.).
- Coverage support integrated.

## 8.4 OpenAPI document

Why chosen:

- Gives machine-readable contract for consumers.
- Helps client developers understand endpoint/query/response schema.

## 8.5 Cache strategy

Why chosen:

- Reduces repeated Drive reads.
- Keeps response latency lower.
- Month-split cache for XML allows controlled memory usage and rebuild behavior.

---

## 9. Configuration Specification

Configuration is read from **Script Properties** (Apps Script).

Required properties for normal (non-debug) operation:

- `GOOGLE_OAUTH_CLIENT_ID`
  - expected audience value for ID token verification.
- `AVAILABLE_GMAILS`
  - comma-separated allowed emails.
  - comparison is lowercased and trimmed.

Optional properties:

- `DEBUG`
  - `true` disables auth checks.
  - any other value keeps auth enabled.

Hard-coded constants in code:

- `FOLDER_ID`: target Google Drive folder ID.
- `MAX_CACHE_DURATION_SECONDS`: 21600 (6h).

---

## 10. Setup, Build, Test, Deploy

## 10.1 Prerequisites

- Node.js + npm
- Google Apps Script project linked with `clasp`
- Access to target Google Drive folder

## 10.2 Local Setup

```bash
npm install
```

## 10.3 Test

```bash
npm test
```

Runs Vitest with V8 coverage on `src/**/*.js`.

## 10.4 Build

```bash
npm run build
```

Build behavior:

1. reads `src/Code.js`
2. removes `export` statements
3. writes `dist/Code.gs`
4. copies `appsscript.json` to `dist/appsscript.json`

## 10.5 Deploy

```bash
npm run deploy
```

Deploy script runs build then:

```bash
clasp push --force
```

Important scope-update note:

If you changed `oauthScopes` in `appsscript.json`, pushing code is not enough for existing deployment.
After deploy, create new version and redeploy that version/deployment ID.
Then re-authorize with deploying account (because executeAs is USER_DEPLOYING).

## 10.6 Manifest Details

`appsscript.json` currently sets:

- timezone: `Asia/Tokyo`
- runtime: `V8`
- exception logging: `STACKDRIVER`
- scopes:
  - drive.readonly
  - drive
  - script.external_request
- webapp:
  - executeAs: `USER_DEPLOYING`
  - access: `ANYONE`

---

## 11. Security Model

## 11.1 Access level

Web App access is `ANYONE`, but application-level auth gate is inside `doGet`.
So practical access is controlled by ID token + allow list.

## 11.2 Token verification endpoint

Uses Google endpoint:

- `https://oauth2.googleapis.com/tokeninfo?id_token=<token>`

Because this is remote verification, app requires external request scope.

## 11.3 Debug mode caution

If `DEBUG=true`, auth is fully bypassed.
Use only in safe development contexts.

---

## 12. Testing Strategy and Coverage Intent

The repository includes unit tests for:

- CSV parsing and formatting behavior
- endpoint route behavior and auth outcomes
- cache behavior paths
- XML parsing, ordering, and date handling
- build script behavior

Goal of tests:

- preserve stable JSON contracts,
- detect regressions in parsing logic,
- validate tricky edge cases (MM/DD with file-year injection, etc.).

---

## 13. Operational Notes

- Cache TTL is 6 hours, but manual warm-up exists via `f=preCacheAll`.
- If cache contents are inconsistent, service safely rebuilds from live files.
- XML parse failure in one file does not stop other files.
- Error information is included in JSON body for troubleshooting.

---

## 14. Known Constraints

- Source folder ID is hardcoded in code (not property-based yet).
- API response includes all CSV files; no selective query by file type.
- HTTP response code is not explicitly set to 401/403, only JSON payload shows status.
- XML parsing is regex-based and depends on expected text patterns.

---

## 15. Suggested Future Improvements (Optional)

- Move `FOLDER_ID` to Script Properties.
- Return actual HTTP status code with body status for better API semantics.
- Add schema validation for CSV headers by file type.
- Add optional query filters (e.g., only one dataset).
- Add structured logging with correlation IDs.

---

## 16. Quick Reference

- Entry point: `doGet(e)`
- Cache warm: `GET /exec?f=preCacheAll`
- Auth token:
  - Header: `Authorization: Bearer <id_token>`
  - or query: `id_token=<id_token>`
- Main output: merged CSV datasets + `mfcf` transactions

