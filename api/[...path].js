'use strict';

/*
 * Vercel catch-all API function.
 * Все запросы /api/* попадают сюда, а дальше работает тот же код, что и в
 * локальном server.js. Так приложение одинаково ведёт себя локально и на Vercel.
 */

const { handleRequest } = require('../server.js');

module.exports = async function handler(req, res) {
  if (!req.url || !req.url.startsWith('/api')) {
    const rawPath = req.query && req.query.path;
    const suffix = Array.isArray(rawPath) ? rawPath.join('/') : rawPath || '';
    req.url = `/api/${suffix}`;
  }
  return handleRequest(req, res);
};

module.exports.config = { maxDuration: 60 };
