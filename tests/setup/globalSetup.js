// Vitest globalSetup: runs ONCE, before any test file, in its own process
// context (separate from tests/setup/env.setup.js). Creates the isolated test
// database (if missing) and (re)creates its schema from schema.sql.
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD;
  const baseDbName = process.env.DB_NAME || 'Student_Helper2_DB';
  const testDbName = process.env.TEST_DB_NAME || `${baseDbName}_test`;

  let connection;
  try {
    connection = await mysql.createConnection({ host, user, password, multipleStatements: true });
  } catch (error) {
    console.warn(
      `\n[tests] Could not connect to MySQL at ${host} as ${user} (${error.message}). ` +
      `Skipping test-database setup - unit tests will still run, but any integration ` +
      `test that touches the database will fail on its own with a connection error.\n`
    );
    return;
  }

  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${testDbName}\``);
    await connection.query(`USE \`${testDbName}\``);

    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await connection.query(schemaSql);

    console.log(`[tests] Test database ready: ${testDbName}`);
  } finally {
    await connection.end();
  }
}
