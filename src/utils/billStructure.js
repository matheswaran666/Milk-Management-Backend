/**
 * Helpers for parsing and validating bill-structure templates,
 * and for applying a template to OCR-extracted text or word boxes.
 *
 * Two extraction paths are supported:
 *   1. extractRecordsFromOcrData(words, fields)  — geometry-aware (preferred).
 *      Clusters Tesseract word boxes into rows by y-centre, then assigns each
 *      word to the column whose header x-centre is closest. Robust to OCR
 *      slips that the positional path silently corrupts.
 *   2. extractRecordsWithStructure(rawText, fields) — text/positional fallback.
 *      Used when no word boxes are available (legacy callers, very small
 *      images, or workers that didn't return geometry).
 */

// Canonical field catalogue.
// Each entry maps a canonical key to its data type and the default keyword
// aliases commonly seen on printed bills. Users can extend or override aliases
// per plant when they upload an example bill.
const CANONICAL_FIELDS = {
  date:              { label: 'Date',              type: 'date',    aliases: ['date', 'dt'] },
  shift:             { label: 'Shift',             type: 'enum',    aliases: ['shift', 'am', 'pm', 'morning', 'evening'] },
  milk_type:         { label: 'Milk Type',         type: 'enum',    aliases: ['type', 'cm', 'bm', 'cow', 'buffalo'] },
  quantity_liters:   { label: 'Quantity (Ltr)',    type: 'number',  aliases: ['qty', 'quantity', 'ltr', 'liters', 'litre', 'vol'] },
  quantity_kgs:      { label: 'Quantity (Kg)',     type: 'number',  aliases: ['kg', 'kgs', 'weight'] },
  fat_percentage:    { label: 'Fat %',             type: 'number',  aliases: ['fat', 'fat%', 'fatpct'] },
  snf_percentage:    { label: 'SNF %',             type: 'number',  aliases: ['snf', 'snf%'] },
  clr:               { label: 'CLR',               type: 'number',  aliases: ['clr'] },
  rate_per_liter:    { label: 'Rate / Ltr',        type: 'number',  aliases: ['rate', 'price', 'ratepl', 'rateperltr'] },
  total_amount:      { label: 'Amount',            type: 'number',  aliases: ['amount', 'amt', 'total', 'net'] },
  incentive:         { label: 'Incentive',         type: 'number',  aliases: ['incentive', 'bonus'] },
  deduction:         { label: 'Deduction',         type: 'number',  aliases: ['deduction', 'deduct', 'less'] },
};

const CANONICAL_KEYS = Object.keys(CANONICAL_FIELDS);

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

function normaliseFields(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Bill structure must include at least one field.');
  }

  const seen = new Set();
  const result = [];

  input.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Field #${idx + 1} is invalid.`);
    }
    const key = String(raw.key || '').trim();
    if (!key) throw new Error(`Field #${idx + 1} is missing a key.`);
    if (!CANONICAL_KEYS.includes(key)) {
      throw new Error(`Unknown field "${key}". Allowed: ${CANONICAL_KEYS.join(', ')}.`);
    }
    if (seen.has(key)) throw new Error(`Duplicate field "${key}".`);
    seen.add(key);

    const catalog = CANONICAL_FIELDS[key];
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
      : [];
    // Always include the canonical defaults so extraction is robust
    const mergedAliases = Array.from(new Set([...catalog.aliases, ...aliases]));

    result.push({
      key,
      label: String(raw.label || catalog.label).trim() || catalog.label,
      type:  catalog.type,
      aliases: mergedAliases,
      order: Number.isFinite(raw.order) ? Number(raw.order) : idx,
    });
  });

  result.sort((a, b) => a.order - b.order);
  return result.map((f, i) => ({ ...f, order: i }));
}

// ────────────────────────────────────────────────────────────────
// Header detection (text-only fallback)
// ────────────────────────────────────────────────────────────────

const ALIAS_BOUNDARY_LEFT  = '(^|[^a-z0-9])';
const ALIAS_BOUNDARY_RIGHT = '($|[^a-z0-9])';

function aliasRegex(alias) {
  // % is allowed in canonical aliases like 'fat%' — escape it for the regex.
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${ALIAS_BOUNDARY_LEFT}${escaped}${ALIAS_BOUNDARY_RIGHT}`, 'i');
}

/**
 * Score every non-empty line by how many canonical fields' aliases hit it.
 * Returns the line with the highest score (or null if no line scores ≥ 2).
 * This is far more reliable than "first 5 lines" — many bills have a logo /
 * plant address above the header row.
 */
function findHeaderLine(lines) {
  let best = null;
  let bestScore = 0;

  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    let score = 0;
    const keysHit = new Set();
    CANONICAL_KEYS.forEach((key) => {
      if (CANONICAL_FIELDS[key].aliases.some((a) => aliasRegex(a).test(lower))) {
        score += 1;
        keysHit.add(key);
      }
    });
    if (score > bestScore) {
      bestScore = score;
      best = { line, idx, score, keysHit };
    }
  });

  // Require at least two distinct field hits — guards against a stray "amt"
  // somewhere in body text being mistaken for a header.
  return bestScore >= 2 ? best : null;
}

/**
 * Suggest a `fields` array from raw OCR text.
 * Strategy: find the best-scoring header line, then pick canonical fields whose
 * aliases appear on it. Falls back to scanning the whole document if no clear
 * header is found (better than returning nothing).
 */
function suggestFieldsFromOcr(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const header = findHeaderLine(lines);
  const blob = (header ? header.line : lines.join(' ')).toLowerCase();

  const picked = [];
  CANONICAL_KEYS.forEach((key) => {
    if (CANONICAL_FIELDS[key].aliases.some((a) => aliasRegex(a).test(blob))) {
      picked.push({
        key,
        label: CANONICAL_FIELDS[key].label,
        type: CANONICAL_FIELDS[key].type,
        aliases: CANONICAL_FIELDS[key].aliases,
        order: picked.length,
      });
    }
  });
  return picked;
}

// ────────────────────────────────────────────────────────────────
// Date parsing — broader format support
// ────────────────────────────────────────────────────────────────

/**
 * Try multiple date formats. Returns `YYYY-MM-DD` or null.
 * Supported:
 *   dd[-/.]mm[-/.]yy(yy)
 *   yyyy[-/.]mm[-/.]dd
 *   dd <Mon> yyyy   (Mon = Jan|Feb|… or full month, case-insensitive)
 */
function extractDateFromLine(line) {
  if (!line) return null;
  const s = String(line);

  // dd-mm-yy(yy) / dd/mm/yy(yy) / dd.mm.yy(yy)
  let m = s.match(/(\b\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
  if (m) {
    const d  = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const y  = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    if (isValidDate(y, mo, d)) return formatYmd(y, mo, d);
  }

  // yyyy-mm-dd / yyyy/mm/dd / yyyy.mm.dd
  m = s.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) {
    const y  = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d  = parseInt(m[3], 10);
    if (isValidDate(y, mo, d)) return formatYmd(y, mo, d);
  }

  // dd Mon yyyy  (e.g. 01 Apr 2024, 1-Apr-24, 01 April 2024)
  m = s.match(/\b(\d{1,2})[\s.\-/]+([A-Za-z]{3,9})[\s.\-/]+(\d{2,4})\b/);
  if (m) {
    const d  = parseInt(m[1], 10);
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    const y  = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    if (mo && isValidDate(y, mo, d)) return formatYmd(y, mo, d);
  }

  return null;
}

function isValidDate(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (y < 1900 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // JS Date for cross-validation
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function formatYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Strip the matched date substring(s) from a line so they aren't picked up
 * as numbers. Mirrors the formats supported by extractDateFromLine.
 */
function stripDates(line) {
  return String(line || '')
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[\s.\-/]+[A-Za-z]{3,9}[\s.\-/]+\d{2,4}\b/g, ' ');
}

// ────────────────────────────────────────────────────────────────
// Shift / milk-type detection — tightened so substrings of words don't match
// ────────────────────────────────────────────────────────────────

function detectShift(line) {
  const l = ` ${String(line).toLowerCase()} `;
  // Require non-letter on both sides; "am" inside "amount" is rejected.
  if (/[^a-z](am|morning)[^a-z]/.test(l)) return 'AM';
  if (/[^a-z](pm|evening)[^a-z]/.test(l)) return 'PM';
  return null;
}

function detectMilkType(line) {
  const l = ` ${String(line).toLowerCase()} `;
  if (/[^a-z](bm|buffalo)[^a-z]/.test(l)) return 'BM';
  if (/[^a-z](cm|cow)[^a-z]/.test(l)) return 'CM';
  return null;
}

// ────────────────────────────────────────────────────────────────
// Number extraction — safer cleaning
// ────────────────────────────────────────────────────────────────

/**
 * Extract numeric tokens from a line WITHOUT corrupting them.
 *
 * Older code did: replace([:;,-]) → '.'  which turned timestamps like
 * "06:30" into "6.30" and treated them as decimal numbers. We now:
 *   1. Strip any hh:mm[:ss] timestamps first.
 *   2. Replace ',' → '.' (European decimal) only when between two digits.
 *   3. Match plain decimals.
 */
function extractNumbersFromLine(line) {
  let s = String(line || '');
  // Remove timestamps so "06:30" doesn't become a number.
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  // Treat comma as decimal separator only when between digits ("12,5" → "12.5"),
  // not as a thousands separator ("1,200") which we want to keep.
  s = s.replace(/(\d),(\d)/g, '$1.$2');
  // Drop any remaining commas/semicolons used as field separators.
  s = s.replace(/[;,]/g, ' ');
  const matches = s.match(/-?\d+(?:\.\d+)?/g) || [];
  return matches.map(parseFloat).filter((n) => !Number.isNaN(n));
}

// ────────────────────────────────────────────────────────────────
// Text/positional extraction (fallback path)
// ────────────────────────────────────────────────────────────────

function extractRecordsWithStructure(rawText, fields) {
  const normalised = Array.isArray(fields) ? fields : [];
  const hasDate = normalised.some((f) => f.key === 'date');
  const numericFieldsInOrder = normalised
    .filter((f) => f.type === 'number')
    .sort((a, b) => a.order - b.order);
  const hasShift = normalised.some((f) => f.key === 'shift');
  const hasMilkType = normalised.some((f) => f.key === 'milk_type');

  const lines = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const records = [];

  lines.forEach((line) => {
    const record = {};

    if (hasDate) {
      const d = extractDateFromLine(line);
      if (!d) return; // No date → not a data row
      record.date = d;
    }

    if (hasShift) {
      const s = detectShift(line);
      if (s) record.shift = s;
    }

    if (hasMilkType) {
      const t = detectMilkType(line);
      if (t) record.milk_type = t;
    }

    const withoutDate = stripDates(line);
    const nums = extractNumbersFromLine(withoutDate);
    numericFieldsInOrder.forEach((f, i) => {
      if (i < nums.length) record[f.key] = nums[i];
    });

    const hasValue = Object.keys(record).some((k) => k !== 'date' && record[k] != null);
    if (hasValue || (hasDate && record.date)) {
      records.push(record);
    }
  });

  return records;
}

// ────────────────────────────────────────────────────────────────
// Geometry-aware extraction (preferred path)
// ────────────────────────────────────────────────────────────────

/**
 * Cluster Tesseract word objects into rows by y-centre.
 * Two words belong to the same row if their y-centres are within `tolerance`
 * pixels — defaulted to half the median word height so it adapts to scale.
 * Returns: Array<{ yCentre, words: Word[] }>, top-to-bottom.
 */
function clusterWordsIntoRows(words) {
  if (!Array.isArray(words) || !words.length) return [];

  const enriched = words
    .filter((w) => w && w.bbox && Number.isFinite(w.bbox.y0) && Number.isFinite(w.bbox.y1))
    .map((w) => ({
      word: w,
      yCentre: (w.bbox.y0 + w.bbox.y1) / 2,
      xCentre: (w.bbox.x0 + w.bbox.x1) / 2,
      height: Math.max(1, w.bbox.y1 - w.bbox.y0),
    }))
    .sort((a, b) => a.yCentre - b.yCentre);

  if (!enriched.length) return [];

  const heights = enriched.map((w) => w.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 10;
  const tolerance = Math.max(4, medianHeight * 0.6);

  const rows = [];
  let current = null;
  enriched.forEach((w) => {
    if (!current || Math.abs(w.yCentre - current.yCentre) > tolerance) {
      current = { yCentre: w.yCentre, words: [w] };
      rows.push(current);
    } else {
      current.words.push(w);
      // Update centre as running mean — keeps tolerance accurate for tall rows.
      current.yCentre = current.words.reduce((sum, x) => sum + x.yCentre, 0) / current.words.length;
    }
  });

  // Sort each row left-to-right
  rows.forEach((r) => r.words.sort((a, b) => a.xCentre - b.xCentre));
  return rows;
}

/**
 * Find the row most likely to be the header (highest alias-hit count).
 * Returns { row, columnsByKey } where columnsByKey maps each detected canonical
 * field key → x-centre of its header word(s).
 */
function detectHeaderRow(rows, fields) {
  const fieldList = Array.isArray(fields) ? fields : [];
  if (!rows.length || !fieldList.length) return null;

  let best = null;
  let bestScore = 0;

  rows.forEach((row, idx) => {
    const columnsByKey = {};
    fieldList.forEach((f) => {
      // For each field, find header word(s) whose text matches an alias.
      const matches = row.words.filter((w) => {
        const text = (w.word.text || '').toLowerCase().replace(/[^a-z0-9%]/g, '');
        if (!text) return false;
        return f.aliases.some((a) => text === a.toLowerCase() || text.includes(a.toLowerCase()));
      });
      if (matches.length) {
        // Use the centre of the matched span
        const x0 = Math.min(...matches.map((m) => m.word.bbox.x0));
        const x1 = Math.max(...matches.map((m) => m.word.bbox.x1));
        columnsByKey[f.key] = (x0 + x1) / 2;
      }
    });
    const score = Object.keys(columnsByKey).length;
    if (score > bestScore) {
      bestScore = score;
      best = { row, idx, columnsByKey };
    }
  });

  // Need at least 2 column anchors to trust geometry — otherwise positional
  // mapping on text is just as good and simpler.
  return bestScore >= 2 ? best : null;
}

/**
 * Assign each word in a data row to the field whose header x-centre is
 * closest, but only if it's within `maxDistance` (half the average column
 * gap). Words too far from any header column are ignored.
 */
function assignWordsToColumns(rowWords, columnsByKey) {
  const keys = Object.keys(columnsByKey);
  if (!keys.length) return {};

  const xs = keys.map((k) => columnsByKey[k]).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 80;
  const maxDistance = Math.max(40, avgGap * 0.6);

  const buckets = {};
  keys.forEach((k) => { buckets[k] = []; });

  rowWords.forEach((w) => {
    let bestKey = null;
    let bestDist = Infinity;
    keys.forEach((k) => {
      const d = Math.abs(w.xCentre - columnsByKey[k]);
      if (d < bestDist) { bestDist = d; bestKey = k; }
    });
    if (bestKey && bestDist <= maxDistance) {
      buckets[bestKey].push(w);
    }
  });

  return buckets;
}

/**
 * Geometry-aware extraction. Uses word bounding boxes from Tesseract to align
 * data cells under their header columns instead of relying on positional
 * order — which makes us robust to dropped/split numbers in the middle of a
 * row. Falls back to positional extraction when geometry is unusable.
 *
 * @param {Array} words - Tesseract word objects with .text, .bbox, .confidence
 * @param {Array} fields - normalised structure fields
 * @param {string} rawText - same OCR text, used for fallback + line-level shift/type detection
 */
function extractRecordsFromOcrData(words, fields, rawText) {
  const fieldList = Array.isArray(fields) ? fields : [];
  if (!fieldList.length) return { records: [], usedGeometry: false };

  const rows = clusterWordsIntoRows(words);
  const header = detectHeaderRow(rows, fieldList);

  // Not enough geometry to trust — fall back.
  if (!header) {
    return {
      records: extractRecordsWithStructure(rawText || '', fieldList),
      usedGeometry: false,
    };
  }

  const dataRows = rows.slice(header.idx + 1);
  const records = [];
  const hasDate = fieldList.some((f) => f.key === 'date');

  dataRows.forEach((row) => {
    const buckets = assignWordsToColumns(row.words, header.columnsByKey);
    const record = {};
    let confSum = 0;
    let confCount = 0;
    const lineText = row.words.map((w) => w.word.text).join(' ');

    fieldList.forEach((f) => {
      const wordsInCol = buckets[f.key] || [];
      if (!wordsInCol.length) return;
      const text = wordsInCol.map((w) => w.word.text).join(' ').trim();
      wordsInCol.forEach((w) => {
        if (Number.isFinite(w.word.confidence)) {
          confSum += w.word.confidence;
          confCount += 1;
        }
      });
      if (f.type === 'date') {
        const d = extractDateFromLine(text) || extractDateFromLine(lineText);
        if (d) record.date = d;
      } else if (f.type === 'number') {
        const nums = extractNumbersFromLine(text);
        if (nums.length) record[f.key] = nums[0];
      } else if (f.key === 'shift') {
        record.shift = detectShift(text) || detectShift(lineText) || undefined;
      } else if (f.key === 'milk_type') {
        record.milk_type = detectMilkType(text) || detectMilkType(lineText) || undefined;
      }
    });

    // Only keep rows that look like data: must have a date when one is in the
    // structure, and at least one value.
    const hasValue = Object.keys(record).some((k) => k !== 'date' && record[k] != null);
    if ((!hasDate || record.date) && (hasValue || record.date)) {
      record._confidence = confCount ? Math.round(confSum / confCount) : null;
      records.push(record);
    }
  });

  return { records, usedGeometry: true };
}

module.exports = {
  CANONICAL_FIELDS,
  CANONICAL_KEYS,
  normaliseFields,
  suggestFieldsFromOcr,
  findHeaderLine,
  extractRecordsWithStructure,
  extractRecordsFromOcrData,
  extractDateFromLine,
  stripDates,
  extractNumbersFromLine,
  detectShift,
  detectMilkType,
  clusterWordsIntoRows,
};
