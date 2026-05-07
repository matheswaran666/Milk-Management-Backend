const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pool } = require('../config/db');
const ocrWorker = require('../utils/ocrWorker');
const {
  CANONICAL_FIELDS,
  normaliseFields,
  suggestFieldsFromOcr,
} = require('../utils/billStructure');
const { detectIsExcel, processExcelSample } = require('../utils/excelBillSample');

// Plants visible to a user = global defaults (user_id IS NULL) ∪ their own.
// Mutations restricted to user's own plants (defaults are read-only).

const getMilkPlants = async (req, res) => {
  try {
    const userId = req.user.id;
    // Use a sub-query for entry counts to avoid inflated counts from JOINs
    const [rows] = await pool.execute(
      `SELECT mp.id, mp.user_id, mp.name, mp.is_active, mp.created_at,
              COALESCE(ec.cnt, 0) AS entries_count
       FROM milk_plants mp
       LEFT JOIN (
         SELECT milk_plant, COUNT(*) AS cnt
         FROM milk_entries
         WHERE user_id = ?
         GROUP BY milk_plant
       ) ec ON ec.milk_plant COLLATE utf8mb4_unicode_ci = mp.name
       WHERE mp.user_id IS NULL OR mp.user_id = ?
       ORDER BY mp.is_active DESC, mp.name ASC`,
      [userId, userId]
    );
    // Mark whether each row is a global default (read-only) for the frontend
    const data = rows.map((r) => ({
      ...r,
      is_default: r.user_id === null,
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('getMilkPlants error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load milk plants.' });
  }
};

const getActiveMilkPlantOptions = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.execute(
      `SELECT name
       FROM milk_plants
       WHERE is_active = 1 AND (user_id IS NULL OR user_id = ?)
       ORDER BY name ASC`,
      [userId]
    );
    res.json({ success: true, data: rows.map((r) => r.name) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load milk plant options.' });
  }
};

const createMilkPlant = async (req, res) => {
  try {
    const name = (req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Plant name is required.' });
    }

    // Block creating a plant whose name collides with a global default —
    // the user already sees that default; no point owning a duplicate.
    const [globalDup] = await pool.execute(
      `SELECT id FROM milk_plants WHERE user_id IS NULL AND name = ? LIMIT 1`,
      [name]
    );
    if (globalDup.length) {
      return res.status(409).json({ success: false, message: 'A default plant with that name already exists.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO milk_plants (user_id, name, is_active) VALUES (?, ?, 1)`,
      [req.user.id, name]
    );
    res.status(201).json({ success: true, message: 'Milk plant added.', data: { id: result.insertId, name } });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'You already have a plant with that name.' });
    }
    res.status(500).json({ success: false, message: 'Failed to add milk plant.' });
  }
};

const updateMilkPlant = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = (req.body?.name || '').trim();
    const isActive = req.body?.is_active;

    const [existingRows] = await pool.execute(`SELECT * FROM milk_plants WHERE id = ?`, [id]);
    if (!existingRows.length) {
      return res.status(404).json({ success: false, message: 'Milk plant not found.' });
    }

    const existing = existingRows[0];
    if (existing.user_id === null) {
      return res.status(403).json({ success: false, message: 'Default milk plants cannot be edited.' });
    }
    // Use Number() for safe comparison (MySQL may return bigint)
    if (Number(existing.user_id) !== Number(req.user.id)) {
      return res.status(404).json({ success: false, message: 'Milk plant not found.' });
    }

    const nextName = name || existing.name;
    // Accept booleans, numbers (0/1), and string ("true"/"false")
    let nextIsActive = existing.is_active;
    if (typeof isActive === 'boolean') {
      nextIsActive = isActive ? 1 : 0;
    } else if (typeof isActive === 'number') {
      nextIsActive = isActive ? 1 : 0;
    }

    await pool.execute(
      `UPDATE milk_plants SET name = ?, is_active = ? WHERE id = ? AND user_id = ?`,
      [nextName, nextIsActive, id, req.user.id]
    );

    if (nextName !== existing.name) {
      // Rename the plant on this user's milk_entries only.
      await pool.execute(
        `UPDATE milk_entries SET milk_plant = ? WHERE milk_plant = ? AND user_id = ?`,
        [nextName, existing.name, req.user.id]
      );
    }

    res.json({ success: true, message: 'Milk plant updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'You already have a plant with that name.' });
    }
    console.error('updateMilkPlant error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update milk plant.' });
  }
};

const deleteMilkPlant = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [plantRows] = await pool.execute(`SELECT id, user_id, name FROM milk_plants WHERE id = ?`, [id]);
    if (!plantRows.length) {
      return res.status(404).json({ success: false, message: 'Milk plant not found.' });
    }
    const plant = plantRows[0];
    if (plant.user_id === null) {
      return res.status(403).json({ success: false, message: 'Default milk plants cannot be deleted.' });
    }
    if (Number(plant.user_id) !== Number(req.user.id)) {
      return res.status(404).json({ success: false, message: 'Milk plant not found.' });
    }

    const [[usage]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM milk_entries WHERE milk_plant = ? AND user_id = ?`,
      [plant.name, req.user.id]
    );
    if (usage.total > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete a plant already used in entries. Mark it inactive instead.'
      });
    }

    await pool.execute(`DELETE FROM milk_plants WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ success: true, message: 'Milk plant deleted.' });
  } catch (err) {
    console.error('deleteMilkPlant error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete milk plant.' });
  }
};

// ────────────────────────────────────────────────────────────────
// Bill-structure endpoints — access is controlled by plant ownership/visibility.
// ────────────────────────────────────────────────────────────────

const getFieldCatalog = async (_req, res) => {
  const catalog = Object.entries(CANONICAL_FIELDS).map(([key, v]) => ({
    key,
    label: v.label,
    type: v.type,
    default_aliases: v.aliases,
  }));
  res.json({ success: true, data: catalog });
};

// Allow read of structure for any plant the user can see;
// mutations only on plants the user owns.
const ensurePlantVisible = async (plantId, userId) => {
  const [rows] = await pool.execute(
    `SELECT id, user_id FROM milk_plants WHERE id = ? AND (user_id IS NULL OR user_id = ?) LIMIT 1`,
    [plantId, userId]
  );
  return rows[0] || null;
};

const ensurePlantOwned = async (plantId, userId) => {
  const [rows] = await pool.execute(
    `SELECT id FROM milk_plants WHERE id = ? AND user_id = ? LIMIT 1`,
    [plantId, userId]
  );
  return rows.length > 0;
};

const getBillStructure = async (req, res) => {
  try {
    const plantId = req.params.id;
    const visible = await ensurePlantVisible(plantId, req.user.id);
    if (!visible) return res.status(404).json({ success: false, message: 'Milk plant not found.' });

    const [rows] = await pool.execute(
      `SELECT s.id, s.plant_id, s.fields, s.notes, s.raw_ocr_text,
              (s.sample_image IS NOT NULL) AS has_sample_image,
              s.sample_image_mime, s.created_at, s.updated_at,
              p.name AS plant_name
       FROM milk_plants p
       LEFT JOIN milk_plant_bill_structures s ON s.plant_id = p.id
       WHERE p.id = ?`,
      [plantId]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Milk plant not found.' });
    }
    const row = rows[0];
    let fields = [];
    if (row.fields) {
      try {
        fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
      } catch (_) { fields = []; }
    }
    res.json({
      success: true,
      data: {
        plant_id: Number(plantId),
        plant_name: row.plant_name,
        exists: !!row.id,
        fields,
        notes: row.notes || '',
        has_sample_image: !!row.has_sample_image,
        sample_image_mime: row.sample_image_mime || null,
        raw_ocr_text: row.raw_ocr_text || '',
        updated_at: row.updated_at,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load bill structure.' });
  }
};

const saveBillStructure = async (req, res) => {
  try {
    const plantId = req.params.id;
    const { fields, notes } = req.body || {};

    if (!(await ensurePlantOwned(plantId, req.user.id))) {
      return res.status(403).json({ success: false, message: 'Bill structure can only be saved on your own plants.' });
    }

    let normalised;
    try {
      normalised = normaliseFields(fields);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    await pool.execute(
      `INSERT INTO milk_plant_bill_structures (plant_id, fields, notes)
       VALUES (?, CAST(? AS JSON), ?)
       ON DUPLICATE KEY UPDATE
         fields = CAST(VALUES(fields) AS JSON),
         notes = VALUES(notes)`,
      [plantId, JSON.stringify(normalised), notes || null]
    );
    res.json({ success: true, message: 'Bill structure saved.', data: { fields: normalised } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save bill structure.' });
  }
};

/**
 * Upload an example bill for a plant. Accepts either:
 *   - A direct image (JPG/PNG/WebP/...) — sent straight to the OCR worker.
 *   - An Excel file (.xlsx/.xls)        — many users keep their bills as a
 *     screenshot pasted into a sheet. We extract the largest embedded image
 *     and OCR that. If no embedded image is present we parse the cell text
 *     and run the alias-based field detector on it.
 *
 * The original uploaded bytes are stored on the row so the user can still
 * preview/download exactly what they uploaded.
 */
const uploadBillStructureSample = async (req, res) => {
  // Track everything we may need to clean up so we never leak temp files.
  const tempPaths = [];
  const cleanup = () => {
    tempPaths.forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
  };

  try {
    const plantId = req.params.id;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }
    tempPaths.push(req.file.path);

    if (!(await ensurePlantOwned(plantId, req.user.id))) {
      cleanup();
      return res.status(403).json({ success: false, message: 'Bill samples can only be uploaded on your own plants.' });
    }

    // ------------------------------------------------------------------
    // Read the original upload — these bytes are what we persist so the
    // user can preview/download exactly what they uploaded.
    // ------------------------------------------------------------------
    const originalBuffer = fs.readFileSync(req.file.path);
    const originalMime = req.file.mimetype || 'application/octet-stream';
    const isExcel = detectIsExcel(req.file);

    const warnings = [];
    let rawText = '';
    let confidence = 0;
    let ocrSourcePath = req.file.path; // path to feed into OCR (may be a derived image)

    // ------------------------------------------------------------------
    // If the upload is Excel, extract its embedded image (if any) and OCR
    // that. If the workbook has no image, OCR is skipped and we rely on
    // the cell text returned by `processExcelSample`.
    // ------------------------------------------------------------------
    if (isExcel) {
      let excelResult;
      try {
        excelResult = await processExcelSample(req.file.path);
      } catch (e) {
        cleanup();
        console.error('uploadBillStructureSample Excel parse error:', e.message);
        return res.status(400).json({
          success: false,
          message: 'The Excel file could not be read. Please make sure it is a valid .xlsx/.xls file.',
        });
      }

      if (excelResult.kind === 'image') {
        // Write the embedded image to a temp file so the existing OCR worker
        // (which expects a path) can process it unchanged.
        const tmpName = `bill-${crypto.randomBytes(6).toString('hex')}-${path.basename(excelResult.name || 'embedded.png')}`;
        const tmpPath = path.join(os.tmpdir(), tmpName);
        fs.writeFileSync(tmpPath, excelResult.buffer);
        tempPaths.push(tmpPath);
        ocrSourcePath = tmpPath;
      } else {
        // No embedded image — use the sheet's plain text directly.
        // OCR is intentionally skipped (it would just churn on a non-image).
        rawText = (excelResult.text || '').trim();
        ocrSourcePath = null;
        if (!rawText) {
          warnings.push(
            'The Excel file did not contain a bill image or any readable text. ' +
            'Please paste a screenshot of the bill into the sheet, or upload an image instead.'
          );
        } else {
          warnings.push(
            'No bill image was found inside the Excel file — we read the sheet text instead. ' +
            'For best results, paste a screenshot of the bill into the sheet.'
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // OCR (skipped if we already have text from a no-image Excel).
    // ------------------------------------------------------------------
    if (ocrSourcePath) {
      try {
        const result = await ocrWorker.recognise(ocrSourcePath);
        rawText = result.text || '';
        confidence = result.confidence || 0;
      } catch (e) {
        console.error('uploadBillStructureSample OCR error:', e.message);
        warnings.push('OCR failed; you can still configure fields manually.');
      }
    }

    if (!rawText.trim() && !warnings.length) {
      warnings.push(
        'OCR returned no text. The image may be too blurry or low-contrast — ' +
        'please retake the photo with better lighting and a flat angle.'
      );
    }
    if (rawText.trim() && confidence && confidence < 60) {
      warnings.push(`Low OCR confidence (${Math.round(confidence)}%). Please review the suggested fields carefully.`);
    }

    const suggested = suggestFieldsFromOcr(rawText);
    if (rawText.trim() && !suggested.length) {
      warnings.push('Could not auto-detect any fields from the bill. Please add them manually.');
    }

    // ------------------------------------------------------------------
    // Persist the original bytes + extracted text + suggested fields.
    // ------------------------------------------------------------------
    const [existing] = await pool.execute(
      `SELECT id, fields FROM milk_plant_bill_structures WHERE plant_id = ?`,
      [plantId]
    );

    if (existing.length) {
      await pool.execute(
        `UPDATE milk_plant_bill_structures
         SET sample_image = ?, sample_image_mime = ?, raw_ocr_text = ?
         WHERE plant_id = ?`,
        [originalBuffer, originalMime, rawText, plantId]
      );
    } else {
      await pool.execute(
        `INSERT INTO milk_plant_bill_structures
          (plant_id, fields, sample_image, sample_image_mime, raw_ocr_text)
         VALUES (?, CAST(? AS JSON), ?, ?, ?)`,
        [plantId, JSON.stringify(suggested), originalBuffer, originalMime, rawText]
      );
    }

    res.json({
      success: true,
      message: 'Sample bill uploaded and analysed.',
      data: {
        raw_ocr_text: rawText,
        suggested_fields: suggested,
        confidence: Math.round(confidence),
        sample_kind: isExcel ? 'excel' : 'image',
        sample_mime: originalMime,
        warnings,
      },
    });
  } catch (err) {
    console.error('uploadBillStructureSample error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process sample bill.' });
  } finally {
    cleanup();
  }
};

const getBillStructureSampleImage = async (req, res) => {
  try {
    const plantId = req.params.id;
    if (!(await ensurePlantVisible(plantId, req.user.id))) {
      return res.status(404).json({ success: false, message: 'No sample image for this plant.' });
    }
    const [rows] = await pool.execute(
      `SELECT sample_image, sample_image_mime
       FROM milk_plant_bill_structures
       WHERE plant_id = ?`,
      [plantId]
    );
    if (!rows.length || !rows[0].sample_image) {
      return res.status(404).json({ success: false, message: 'No sample image for this plant.' });
    }
    const mime = rows[0].sample_image_mime || 'image/png';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    // For non-image samples (Excel) hint that the browser should download
    // rather than try to render. Images stay inline so <img> previews work.
    if (!/^image\//i.test(mime)) {
      res.setHeader('Content-Disposition', 'attachment; filename="example-bill.xlsx"');
    }
    res.send(rows[0].sample_image);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load sample image.' });
  }
};

const deleteBillStructure = async (req, res) => {
  try {
    const plantId = req.params.id;
    if (!(await ensurePlantOwned(plantId, req.user.id))) {
      return res.status(403).json({ success: false, message: 'Bill structure can only be cleared on your own plants.' });
    }
    await pool.execute(
      `DELETE FROM milk_plant_bill_structures WHERE plant_id = ?`,
      [plantId]
    );
    res.json({ success: true, message: 'Bill structure cleared.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to clear bill structure.' });
  }
};

module.exports = {
  getMilkPlants,
  getActiveMilkPlantOptions,
  createMilkPlant,
  updateMilkPlant,
  deleteMilkPlant,
  getFieldCatalog,
  getBillStructure,
  saveBillStructure,
  uploadBillStructureSample,
  getBillStructureSampleImage,
  deleteBillStructure,
};
