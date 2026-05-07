const path = require('path');
const express = require('express');
const multer = require('multer');

const router = express.Router();
const {
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
} = require('../controllers/milkPlantsController');

// Reuse the shared uploads dir used by OCR route
const uploadDir = path.join(__dirname, '..', '..', 'uploads');

// MIME types we accept for the "example bill" upload.
//  - Images: standard photo / scan path → OCR pipeline.
//  - Excel:  many users paste a screenshot of the bill into a spreadsheet
//            instead of saving it as an image. We extract the embedded
//            image(s) from the .xlsx and feed them through the same OCR
//            pipeline. If no embedded image is found we fall back to
//            parsing the cell text.
const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'application/octet-stream', // some browsers send this for .xlsx
]);

const ACCEPTED_EXTENSIONS = /\.(jpe?g|png|webp|bmp|tiff?|xlsx|xls)$/i;

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap for example bills
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const nameOk = ACCEPTED_EXTENSIONS.test(file.originalname || '');
    if (ACCEPTED_MIME_TYPES.has(mime) || nameOk) {
      return cb(null, true);
    }
    return cb(new Error('Only image files (JPG/PNG/WebP) or Excel files (.xlsx/.xls) are accepted.'));
  },
});

// Field catalog (static list of canonical fields UI can pick from).
// Placed before `/:id` so the literal path wins over the param route.
router.get('/field-catalog', getFieldCatalog);

// CRUD
router.get(['/', ''], getMilkPlants);
router.get('/options', getActiveMilkPlantOptions);
router.post('/', createMilkPlant);
router.put('/:id', updateMilkPlant);
router.delete('/:id', deleteMilkPlant);

// Bill-structure endpoints (per plant)
router.get('/:id/bill-structure', getBillStructure);
router.put('/:id/bill-structure', saveBillStructure);
router.delete('/:id/bill-structure', deleteBillStructure);
router.post('/:id/bill-structure/sample', upload.single('image'), uploadBillStructureSample);
router.get('/:id/bill-structure/sample-image', getBillStructureSampleImage);

module.exports = router;
