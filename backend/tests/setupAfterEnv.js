const { resetDb, closeDb } = require('./helpers/db');

// Full isolation: every single test starts against a clean, empty DB (minus
// the reference tables seeded by migrations — see helpers/db.js).
beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeDb();
});

jest.setTimeout(15000);
