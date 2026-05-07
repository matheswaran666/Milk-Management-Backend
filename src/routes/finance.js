const express = require('express');
const router  = express.Router();
const { getFinanceSummary } = require('../controllers/financeController');

router.get('/summary', getFinanceSummary);

module.exports = router;
