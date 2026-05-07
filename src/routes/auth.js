const express = require('express');
const router = express.Router();
const {
  register, login, me, registerValidators, loginValidators,
} = require('../controllers/authController');
const { requireAuth } = require('../middleware/requireAuth');

router.post('/register', registerValidators, register);
router.post('/login',    loginValidators,    login);
router.get('/me',        requireAuth,        me);

module.exports = router;
