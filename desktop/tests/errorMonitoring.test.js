describe('errorMonitoring (desktop)', () => {
  const ORIGINAL_DSN = process.env.SENTRY_DSN;
  afterEach(() => {
    process.env.SENTRY_DSN = ORIGINAL_DSN;
    jest.resetModules();
  });

  it('is disabled and every call is a safe no-op when SENTRY_DSN is not set', () => {
    delete process.env.SENTRY_DSN;
    jest.resetModules();
    const errorMonitoring = require('../server/errorMonitoring');

    errorMonitoring.init();
    expect(errorMonitoring.isEnabled()).toBe(false);
    expect(() => errorMonitoring.captureException(new Error('test'))).not.toThrow();
  });

  it('reports enabled once initialized with a DSN', () => {
    process.env.SENTRY_DSN = 'https://fake@fake.ingest.sentry.io/123';
    jest.resetModules();
    const errorMonitoring = require('../server/errorMonitoring');

    errorMonitoring.init();
    expect(errorMonitoring.isEnabled()).toBe(true);
  });
});
