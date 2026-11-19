// Express 4 does not pass a rejected promise from an async route handler to
// the error handler: the request just never gets an answer and the screen
// spins until it times out. This makes every handler's failure reach the
// app's error handler, which answers with a clear 500 instead.
// (Same idea as the express-async-errors package, without the dependency.)
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncErrorsPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next(); // an error handler: not for normal requests
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
    return undefined;
  };
  Layer.prototype.__asyncErrorsPatched = true;
}

/** What to tell the person when something unexpected failed: never raw database text. */
function publicError(err) {
  const status = err.status || err.statusCode || 500;
  const fromDatabase = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && err.severity !== undefined;
  const sqlite = typeof err.code === 'string' && err.code.startsWith('SQLITE_');
  if (status >= 500 && (fromDatabase || sqlite)) return { status, body: { error: 'Something went wrong saving that. Please try again.' } };
  return { status, body: { error: err.message || 'Internal server error' } };
}

module.exports = { publicError };
