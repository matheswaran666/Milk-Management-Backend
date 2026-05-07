const jwt = require('jsonwebtoken');

const getSecret = () => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) {
    // Defensive: in production this should be set; in dev we generate one in server.js.
    throw new Error('JWT_SECRET is not configured');
  }
  return s;
};

const signToken = (payload, opts = {}) =>
  jwt.sign(payload, getSecret(), { expiresIn: '7d', ...opts });

const requireAuth = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ message: 'Authentication required.' });
    }
    const decoded = jwt.verify(token, getSecret());
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role || 'user' };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please sign in again.' });
    }
    return res.status(401).json({ message: 'Invalid or missing authentication token.' });
  }
};

module.exports = { requireAuth, signToken };
