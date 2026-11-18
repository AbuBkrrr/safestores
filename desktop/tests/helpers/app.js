const request = require('supertest');
const { createApp } = require('../../server/app');

const app = createApp();

module.exports = { app, request: () => request(app) };
