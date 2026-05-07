const express = require('express');
const router = express.Router();
const earningsController = require('../controllers/earningsController');

// Categories
router.get('/categories', earningsController.getCategories);
router.post('/categories', earningsController.createCategory);
router.put('/categories/:id', earningsController.updateCategory);
router.delete('/categories/:id', earningsController.deleteCategory);

// Earnings
router.get('/', earningsController.getAllEarnings);
router.get('/export', earningsController.exportEarningsCSV);
router.get('/:id', earningsController.getEarning);
router.post('/', earningsController.createEarning);
router.put('/:id', earningsController.updateEarning);
router.delete('/:id', earningsController.deleteEarning);

module.exports = router;
