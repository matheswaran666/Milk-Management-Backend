const path = require('path');
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { scanBill } = require('../controllers/ocrController');

// Absolute path so uploads work even if the process cwd is not the backend folder
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
const upload = multer({ dest: uploadDir });

router.post('/scan', upload.single('image'), scanBill);

module.exports = router;
