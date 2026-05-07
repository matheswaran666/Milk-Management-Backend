const fs = require('fs');
const { pool } = require('../config/db');
const ocrWorker = require('../utils/ocrWorker');
const {
  extractRecordsWithStructure,
  extractRecordsFromOcrData,
  extractDateFromLine,
  extractNumbersFromLine,
} = require('../utils/billStructure');

/**
 * OCR processing for bills.
 * If `plant_id` is supplied (form field), the stored bill-structure template
 * for that plant is used to extract records precisely (geometry-aware when
 * Tesseract returns word boxes). Otherwise the legacy heuristic is used for
 * backward compatibility.
 */
const scanBill = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No image uploaded.' });
  }

  const { path } = req.file;
  let text = '';
  let words = [];
  let confidence = 0;
  const warnings = [];

  try {
    const result = await ocrWorker.recognise(path);
    text = result.text || '';
    words = result.words || [];
    confidence = result.confidence || 0;
  } catch (err) {
    console.error('scanBill OCR error:', err.message);
    try { fs.unlinkSync(path); } catch (_) {}
    return res.status(500).json({ success: false, message: 'Failed to read image text.' });
  }
  try { fs.unlinkSync(path); } catch (_) {}

  if (!text.trim()) {
    return res.status(422).json({
      success: false,
      message: 'OCR could not read any text from the image. Please retake the photo with better lighting and a flat angle.',
    });
  }
  if (confidence && confidence < 60) {
    warnings.push(`Low OCR confidence (${Math.round(confidence)}%). Please review extracted records carefully.`);
  }

  try {
    const plantId = req.body?.plant_id || req.query?.plant_id;
    let structureFields = null;

    if (plantId) {
      const [rows] = await pool.execute(
        `SELECT fields FROM milk_plant_bill_structures WHERE plant_id = ?`,
        [plantId]
      );
      if (rows.length && rows[0].fields) {
        try {
          structureFields = typeof rows[0].fields === 'string'
            ? JSON.parse(rows[0].fields)
            : rows[0].fields;
        } catch (_) { structureFields = null; }
      }
    }

    let records;
    let usedGeometry = false;
    if (structureFields && structureFields.length) {
      // Prefer geometry-aware extraction when we have word boxes.
      const out = extractRecordsFromOcrData(words, structureFields, text);
      records = out.records;
      usedGeometry = out.usedGeometry;
      if (!usedGeometry) {
        warnings.push('Could not align bill columns by geometry; using positional fallback. Cross-check the values.');
      }
    } else {
      records = legacyExtract(text);
    }

    res.json({
      success: true,
      data: {
        records,
        rawText: text,
        used_structure: !!(structureFields && structureFields.length),
        used_geometry: usedGeometry,
        confidence: Math.round(confidence),
        warnings,
      },
    });
  } catch (err) {
    console.error('OCR Error:', err);
    res.status(500).json({ success: false, message: 'Failed to process image.' });
  }
};

// Legacy heuristic preserved for plants without a structure template.
function legacyExtract(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const records = [];

  for (const line of lines) {
    const date = extractDateFromLine(line);
    if (!date) continue;

    // Use the safe number extractor so timestamps don't pollute the column list.
    const dataLine = line
      .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, ' ')
      .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, ' ');
    const numbers = extractNumbersFromLine(dataLine);

    const record = { date };
    if (numbers.length === 1) record.amount = numbers[0];
    else if (numbers.length === 2) { record.quantity = numbers[0]; record.amount = numbers[1]; }
    else if (numbers.length >= 3) {
      record.quantity = numbers[0];
      record.fat = numbers[1];
      record.amount = numbers[numbers.length - 1];
    }
    records.push(record);
  }
  return records.filter((r) => r.quantity || r.amount);
}

module.exports = { scanBill };
