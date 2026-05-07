/**
 * Helpers for handling Excel-format "example bill" uploads.
 *
 * Many users keep their bills as `.xlsx` files where the bill is essentially
 * a picture pasted onto a sheet (logo block, header row, sample data rows,
 * totals — all visually like a printed bill). To support that we:
 *
 *   1. Try to extract any embedded image from the workbook
 *      (xl/media/*.png|jpg|jpeg in the zip). If found, return its bytes so the
 *      caller can OCR it through the same Tesseract pipeline used for direct
 *      image uploads.
 *   2. If no embedded image exists, fall back to reading the sheet's cell
 *      text and turning each row into a tab-separated string. This is good
 *      enough for the alias-based field detector in `billStructure.js` to
 *      suggest a layout.
 *
 * Security notes:
 *   - Parsing is performed by `exceljs` (actively maintained, no known CVEs).
 *     We previously used SheetJS's community `xlsx` package which has
 *     unpatched prototype-pollution and ReDoS advisories
 *     (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9).
 *   - We only read; never `eval`, never write back, never execute formulas.
 *   - Embedded image extraction copies bytes from `workbook.model.media`.
 *     No filesystem path is ever derived from workbook contents → no path
 *     traversal possible.
 *   - Output sizes are bounded to MAX_IMAGE_BYTES. Multer caps the original
 *     `.xlsx` upload to 10 MB so any single embedded image is also smaller.
 *   - All cell values are coerced to strings via `String(v)` before joining
 *     → no prototype-poisoned object survives into downstream code.
 */

const path = require('path');
const ExcelJS = require('exceljs');

// Hard cap on extracted image size (defensive — multer caps the .xlsx itself
// to 10 MB, so any single embedded image is also smaller than that).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Defensive cap on text extraction. Real bills are tiny; anything larger is
// almost certainly a malicious or runaway sheet and we refuse to load it
// fully into memory / hand it to the OCR/alias pipeline.
const MAX_ROWS = 5000;
const MAX_COLS = 200;
const MAX_CELL_CHARS = 10000;

const EXCEL_MIME_PATTERNS = [
  /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i, // .xlsx
  /^application\/vnd\.ms-excel/i,                                            // .xls
];

const IMAGE_EXT_TO_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function isExcelMime(mime) {
  if (!mime) return false;
  return EXCEL_MIME_PATTERNS.some((re) => re.test(mime));
}

function isExcelByName(name) {
  return /\.(xlsx|xls)$/i.test(String(name || ''));
}

function detectIsExcel(file) {
  if (!file) return false;
  if (isExcelMime(file.mimetype)) return true;
  // Some browsers send 'application/octet-stream' for .xlsx — fall back to
  // the original filename extension to confirm.
  if (isExcelByName(file.originalname)) return true;
  return false;
}

/**
 * Read a workbook from disk using exceljs. Returns the workbook on success.
 * Throws a wrapped error on parse failure so callers can return a clean 400.
 */
async function readWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (e) {
    const err = new Error(`Could not read Excel file: ${e.message}`);
    err.cause = e;
    throw err;
  }
  return workbook;
}

/**
 * Locate the largest embedded image (PNG/JPG/JPEG/GIF/BMP) in a workbook.
 * Returns:
 *   { buffer, mime, name }   — the largest embedded image, or
 *   null                     — if no embedded image is present.
 *
 * We pick the *largest* image because Excel often keeps a small logo
 * thumbnail next to the bill picture; the bill itself is almost always the
 * biggest picture in the file.
 */
function pickLargestImage(workbook) {
  // exceljs exposes embedded media at workbook.model.media as
  // [{ name, extension, buffer }, ...]. The buffer may be a Buffer or
  // Uint8Array depending on version.
  const media = (workbook && workbook.model && Array.isArray(workbook.model.media))
    ? workbook.model.media
    : [];

  let best = null;
  for (const m of media) {
    if (!m || m.type !== 'image') continue;
    const ext = String(m.extension || '').toLowerCase();
    const mime = IMAGE_EXT_TO_MIME[ext];
    if (!mime) continue; // unknown image extension → skip

    const raw = m.buffer;
    let buf;
    if (Buffer.isBuffer(raw)) buf = raw;
    else if (raw instanceof Uint8Array) buf = Buffer.from(raw);
    else continue;

    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    if (!best || buf.length > best.buffer.length) {
      // Sanitise the file name — never let a workbook-supplied name reach
      // the filesystem with directory components.
      const safeName = `${path.basename(String(m.name || 'embedded'))}.${ext}`;
      best = { buffer: buf, mime, name: safeName };
    }
  }
  return best;
}

/**
 * Convert the first non-empty worksheet to OCR-style text.
 * Each row becomes a tab-joined line; empty rows are dropped.
 * Hard caps (MAX_ROWS / MAX_COLS / MAX_CELL_CHARS) protect against
 * malicious sheets engineered to blow up memory.
 */
function workbookToText(workbook) {
  if (!workbook || !workbook.worksheets || !workbook.worksheets.length) return '';

  for (const sheet of workbook.worksheets) {
    if (!sheet) continue;

    const lines = [];
    const rowCount = Math.min(sheet.rowCount || 0, MAX_ROWS);
    if (!rowCount) continue;

    for (let r = 1; r <= rowCount; r++) {
      const row = sheet.getRow(r);
      if (!row) continue;
      const colCount = Math.min(row.cellCount || 0, MAX_COLS);
      if (!colCount) continue;

      const cells = [];
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        cells.push(cellToString(cell));
      }
      const line = cells.join('\t').trim();
      if (line) lines.push(line);
    }

    if (lines.length) return lines.join('\n');
  }
  return '';
}

/**
 * Coerce any cell value (string, number, date, formula result, rich text,
 * hyperlink, error) to a plain trimmed string. Refuses to recurse into
 * arbitrary objects → no prototype-pollution propagation.
 */
function cellToString(cell) {
  if (!cell) return '';
  const v = cell.value;
  if (v == null) return '';

  let out;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    out = String(v);
  } else if (v instanceof Date) {
    out = v.toISOString();
  } else if (typeof v === 'object') {
    // Rich text → { richText: [{text}, ...] }
    if (Array.isArray(v.richText)) {
      out = v.richText.map((p) => String(p && p.text != null ? p.text : '')).join('');
    }
    // Hyperlink → { text, hyperlink }
    else if (typeof v.text === 'string') {
      out = v.text;
    }
    // Formula → { formula, result }
    else if (Object.prototype.hasOwnProperty.call(v, 'result')) {
      const r = v.result;
      out = r == null ? '' : String(r);
    }
    // Error cell → { error: '#N/A' }
    else if (typeof v.error === 'string') {
      out = v.error;
    }
    else {
      out = '';
    }
  } else {
    out = String(v);
  }

  out = out.trim();
  if (out.length > MAX_CELL_CHARS) out = out.slice(0, MAX_CELL_CHARS);
  return out;
}

/**
 * High-level helper: given an uploaded .xlsx/.xls file, return either:
 *   { kind: 'image', buffer, mime, name }   — embedded image found; OCR it.
 *   { kind: 'text',  text }                  — no image; sheet text only.
 *
 * Throws on unreadable/corrupt files. Callers should catch and return 400.
 *
 * NOTE: this function is now async because exceljs reads asynchronously.
 * The single caller in `milkPlantsController.uploadBillStructureSample`
 * has been updated to await it.
 */
async function processExcelSample(filePath) {
  const workbook = await readWorkbook(filePath);
  const image = pickLargestImage(workbook);
  if (image) {
    return { kind: 'image', buffer: image.buffer, mime: image.mime, name: image.name };
  }
  const text = workbookToText(workbook);
  return { kind: 'text', text: text || '' };
}

module.exports = {
  detectIsExcel,
  isExcelMime,
  isExcelByName,
  processExcelSample,
  workbookToText,
  // exported for tests / advanced callers
  readWorkbook,
  pickLargestImage,
};
