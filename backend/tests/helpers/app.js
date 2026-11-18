const request = require('supertest');
const { createApp } = require('../../src/app');

const app = createApp();

module.exports = { app, request: () => request(app) };
