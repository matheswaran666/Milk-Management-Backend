const express = require('express');
const router  = express.Router();
const {
  getCategories, createCategory, updateCategory, deleteCategory,
  getAllExpenses, getExpense, createExpense, updateExpense, deleteExpense,
  getExpenseSummary, exportExpensesCSV,
} = require('../controllers/expensesController');

// Categories
router.get('/categories',        getCategories);
router.post('/categories',       createCategory);
router.put('/categories/:id',    updateCategory);
router.delete('/categories/:id', deleteCategory);

// Summary & export (before /:id to avoid param collision)
router.get('/summary', getExpenseSummary);
router.get('/export',  exportExpensesCSV);

// CRUD
router.get('/',    getAllExpenses);
router.get('/:id', getExpense);
router.post('/',   createExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
