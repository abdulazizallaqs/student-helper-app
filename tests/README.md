# Testing

Two layers:

- **Unit tests** (`tests/unit/`) - no database, no network (with one
  deliberate exception: `tests/unit/pdfExtraction.test.js` runs the real
  `pdf-parse` package against a real PDF fixture - this is what caught the
  pdf-parse v1 -> v2 API break described below, and mocking it away would
  have hidden the exact bug that broke Quiz/Flashcard generation). Also
  covers validation rules, rate limiter behavior, and the AI service's JSON
  parsing / "not configured" fallbacks (the Gemini SDK itself is mocked
  there, so those never call the real Gemini API).
- **Integration tests** (`tests/integration/`) - spin up the real Express app
  (`app.js`) with [supertest](https://github.com/ladjs/supertest) and hit it
  the same way the frontend does: register/login flows, file upload, the
  `/uploads` access-control fix, favorites, chat, admin login (including the
  legacy-plaintext-password upgrade), and the AI routes (with `aiService`
  mocked, so no real Gemini calls happen here either).

## One-time setup

```bash
npm install
```

Integration tests need a reachable MySQL server - the **same one** your `.env`
already points at (`DB_HOST` / `DB_USER` / `DB_PASSWORD`). They do **not**
touch your real database: on the first run, `tests/setup/globalSetup.js`
automatically creates a separate database named `<DB_NAME>_test` (e.g.
`Student_Helper2_DB_test`) and builds its schema from `tests/setup/schema.sql`.
That schema was reverse-engineered from the SQL in `models/*.js`, since the
repo doesn't have a committed `student_helper_db.sql` to copy - if a query
fails against it, the error will point at exactly which table/column doesn't
match your real schema, and `tests/setup/schema.sql` is the file to adjust.

If you'd rather point at a different test database name, add to `.env`:

```env
TEST_DB_NAME=some_other_name
```

## Running

```bash
npm test              # unit + integration, once
npm run test:watch    # re-run on file changes
npm run test:unit     # just the dependency-free tests
npm run test:integration
```

## Notes

- Every integration test file truncates all tables in the test database
  before each test (`tests/setup/testDb.js`), so tests don't leak state into
  each other and can run in any order.
- `tests/integration/authRateLimit.test.js` is kept in its own file
  deliberately - it deliberately trips the login rate limiter, and that
  limiter's counter is in-memory and shared by every test in a file.
- `tests/fixtures/sample.pdf` is a tiny hand-built (but spec-valid) one-page
  PDF used for upload/AI-tool tests, so the suite doesn't depend on a real
  document being present. `tests/fixtures/sample.txt` exists for the
  "wrong file type" test.
- `tests/setup/globalSetup.js` no longer aborts the *entire* run if MySQL
  isn't reachable - it warns and lets `npm run test:unit` proceed anyway,
  since those tests don't touch the database. `npm test` / `npm run
  test:integration` still need a real MySQL connection (same `.env` as the
  app) for the tests that do.
- Most of this suite still could not be executed in the sandbox it was
  authored in (no access to your MySQL server there). Two of the bugs this
  round *were* verified by actually running code, in an isolated scratch
  install, against the real installed `pdf-parse` package and the real
  `@google/generative-ai` SDK: pdf-parse's v1 -> v2 API break (confirmed the
  old call throws "pdf is not a function" and the new `PDFParse` class call
  extracts real text), and the AI Buddy chat history bug (confirmed the old
  code sent Gemini two consecutive "user" turns with no reply in between on
  literally the first message, and the fix sends one well-formed turn). The
  rest is syntax-checked (`node --check`) and carefully reasoned through, but
  this is still its first real run against your database - if something
  doesn't pass, the error output should make it quick to fix, most likely a
  small mismatch between the inferred `schema.sql` and your actual database
  rather than a deep problem.
