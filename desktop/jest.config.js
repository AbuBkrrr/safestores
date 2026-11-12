module.exports = {
  testEnvironment: 'node',
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.js',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setupAfterEnv.js'],
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,
};
