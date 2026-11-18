const { resetDb } = require('./helpers/db');

beforeEach(() => {
  resetDb();
});

jest.setTimeout(15000);
