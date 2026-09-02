// Import this FIRST in a test file to exercise database file storage.
//
// services/fileStorage.js reads FILE_STORAGE once, at module load, so this has
// to be set before anything imports it. Static ESM imports run in declaration
// order, which is why this must be the first import in the file - the same
// trick tests/setup/relaxAuthLimiter.js uses for the rate limiter.
process.env.FILE_STORAGE = 'database';
