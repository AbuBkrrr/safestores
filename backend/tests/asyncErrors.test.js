// An unexpected failure inside an async route must answer quickly with a plain
// message, never hang the request or show raw database text to staff.
require('../src/utils/asyncErrors');
const express = require('express');
const supertest = require('supertest');
const { publicError } = require('../src/utils/asyncErrors');

function appWith(handler) {
  const app = express();
  app.get('/x', handler);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const { status, body } = publicError(err);
    res.status(status).json(body);
  });
  return app;
}

describe('Unexpected errors in async routes', () => {
  it('answers with 500 instead of hanging', async () => {
    const res = await supertest(appWith(async () => { throw new Error('boom'); })).get('/x').timeout(3000);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });

  it('hides raw database errors behind a plain message', async () => {
    const dbErr = Object.assign(new Error('value too long for type character varying(12)'), { code: '22001', severity: 'ERROR' });
    const res = await supertest(appWith(async () => { throw dbErr; })).get('/x').timeout(3000);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Something went wrong saving that. Please try again.');
  });

  it('keeps a deliberate client error as it is', async () => {
    const res = await supertest(appWith(async () => { throw Object.assign(new Error('Bad input'), { status: 400 }); })).get('/x');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad input');
  });
});
