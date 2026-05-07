const express = require('express');
const router = express.Router();
const { getAllProviders, getProvider, createProvider, updateProvider, deleteProvider } = require('../controllers/providersController');

router.get('/',    getAllProviders);
router.get('/:id', getProvider);
router.post('/',   createProvider);
router.put('/:id', updateProvider);
router.delete('/:id', deleteProvider);

module.exports = router;
