const express = require('express');
const router = express.Router();
const { generateBill, getSummaryReport, getMilkPlants } = require('../controllers/billingController');

router.get('/generate', generateBill);
router.get('/summary',  getSummaryReport);
router.get('/plants', getMilkPlants);

module.exports = router;
