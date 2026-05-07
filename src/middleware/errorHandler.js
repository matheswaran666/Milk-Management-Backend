/**
 * Centralized error handler — never exposes raw DB or stack traces to the client.
 */

// Map of MySQL error codes to user-friendly messages
const MYSQL_ERROR_MESSAGES = {
  ER_DUP_ENTRY:              'A record with this information already exists.',
  ER_NO_REFERENCED_ROW_2:   'The referenced record does not exist.',
  ER_ROW_IS_REFERENCED_2:   'This record is linked to other data and cannot be deleted.',
  ER_BAD_FIELD_ERROR:        'Invalid field in request.',
  ER_PARSE_ERROR:            'Database query error. Please contact support.',
  ER_ACCESS_DENIED_ERROR:    'Database access denied. Check your configuration.',
  ER_BAD_DB_ERROR:           'Database not found. Run the SQL setup file first.',
  ECONNREFUSED:              'Cannot connect to the database. Make sure MySQL is running.',
  PROTOCOL_CONNECTION_LOST:  'Database connection was lost. Please try again.',
  ER_NOT_SUPPORTED_YET:      'This operation is not supported.',
  ER_DATA_TOO_LONG:          'One of the values entered is too long.',
  ER_TRUNCATED_WRONG_VALUE:  'Invalid value provided for one of the fields.',
};

// HTTP status code mappings for known error types
const getStatusCode = (err) => {
  if (err.status || err.statusCode) return err.status || err.statusCode;
  if (err.code === 'ECONNREFUSED')  return 503;
  if (err.code === 'ER_DUP_ENTRY') return 409;
  return 500;
};

const getFriendlyMessage = (err) => {
  // Already a friendly message (set by controllers)
  if (err.isOperational) return err.message;

  // Known MySQL error codes
  if (err.code && MYSQL_ERROR_MESSAGES[err.code]) {
    return MYSQL_ERROR_MESSAGES[err.code];
  }

  // Validation errors from express-validator or manual checks
  if (err.name === 'ValidationError') return err.message;

  // Default fallback — never send raw DB message
  if (process.env.NODE_ENV === 'development') {
    // In dev show the real error in server logs only
    console.error('[ERROR DETAIL]', err.message);
  }

  return 'Something went wrong. Please try again.';
};

// 404 handler
const notFound = (req, res, next) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// Global error handler (must have 4 params for Express to treat as error middleware)
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // Always log the full error server-side
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} →`, err.message || err);

  const status  = getStatusCode(err);
  const message = getFriendlyMessage(err);

  res.status(status).json({ success: false, message });
};

module.exports = { notFound, errorHandler };
