// Runs before every test file. Points the app at an isolated test database so
// tests never touch your real development data, and stops app.js from
// starting a real HTTP server when it's imported by the test suite.
import dotenv from 'dotenv';

dotenv.config();

process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || `${process.env.DB_NAME || 'Student_Helper2_DB'}_test`;

// Semantic search calls Google to embed the query. A test suite must not do
// that: it would need a live key, spend real quota, and turn every search
// assertion into a network-flakiness assertion. Off by default here - the
// tests that exercise the semantic path inject deterministic vectors instead
// (see tests/integration/search-semantic.test.js). Set SEARCH_EMBEDDINGS
// explicitly if you deliberately want to test against the live API.
process.env.SEARCH_EMBEDDINGS = process.env.SEARCH_EMBEDDINGS || 'off';
