describe('errorMonitoring', () => {
  const ORIGINAL_DSN = process.env.SENTRY_DSN;
  afterEach(() => {
    process.env.SENTRY_DSN = ORIGINAL_DSN;
    jest.resetModules();
  });

  it('is disabled and every call is a safe no-op when SENTRY_DSN is not set', () => {
    delete process.env.SENTRY_DSN;
    jest.resetModules();
    const errorMonitoring = require('../src/utils/errorMonitoring');

    errorMonitoring.init();
    expect(errorMonitoring.isEnabled()).toBe(false);

    // None of these should throw even though nothing is initialized.
    expect(() => errorMonitoring.captureException(new Error('test'))).not.toThrow();
    const express = require('express');
    const app = express();
    expect(() => errorMonitoring.attachExpressErrorHandler(app)).not.toThrow();
  });

  it('reports enabled once initialized with a DSN', () => {
    process.env.SENTRY_DSN = 'https://fake@fake.ingest.sentry.io/123';
    jest.resetModules();
    const errorMonitoring = require('../src/utils/errorMonitoring');

    errorMonitoring.init();
    expect(errorMonitoring.isEnabled()).toBe(true);
  });
});
