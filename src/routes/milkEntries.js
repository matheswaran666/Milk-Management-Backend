const express = require('express');
const router = express.Router();
const { getAllEntries, getEntry, createEntry, updateEntry, deleteEntry, exportCSV } = require('../controllers/milkEntriesController');

router.get('/export', exportCSV);
router.get('/',    getAllEntries);
router.get('/:id', getEntry);
router.post('/',   createEntry);
router.put('/:id', updateEntry);
router.delete('/:id', deleteEntry);

module.exports = router;
