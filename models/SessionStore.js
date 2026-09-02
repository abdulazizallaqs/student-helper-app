/**
 * A session store backed by the app's own database pool.
 *
 * WHY NOT A LIBRARY: express-mysql-session is the obvious choice and was used
 * here first. Its latest release pins mysql2 3.10, which carries a high
 * severity advisory, and npm would not dedupe it onto the safe 3.24 the app
 * already depends on. A session store is about seventy lines against a stable
 * interface, so writing it costs less than carrying a vulnerable transitive
 * copy of a driver the app is already using a newer version of.
 *
 * It also means the store shares models/db.js - the same TLS settings, charset
 * and keepalive the rest of the app worked out - rather than opening a second
 * connection with its own, different, configuration.
 *
 * WHY A DATABASE STORE AT ALL: express-session's default keeps every session
 * in this process's memory. On any host that recycles containers - which is
 * every free tier - that means users are signed out at random, whenever the
 * platform decides to restart the app. It also loses the OAuth state that
 * makes Google sign-in safe, mid-handshake.
 */
import session from 'express-session';
import db from './db.js';

const TABLE = 'Sessions';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    sessionId VARCHAR(128) NOT NULL PRIMARY KEY,
    expiresAt BIGINT NOT NULL,
    data MEDIUMTEXT NOT NULL,
    INDEX idx_sessions_expires (expiresAt)
  ) ENGINE=InnoDB`;

const DEFAULT_TTL_MS = 86400000; // 1 day, matching the cookie
const SWEEP_INTERVAL_MS = 900000; // 15 minutes

export default class DatabaseSessionStore extends session.Store {
    constructor(options = {}) {
        super(options);
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
        this.ready = db.query(CREATE_TABLE).then(() => true);

        // Expired rows are never read, but they are never removed either
        // unless something removes them - and on a 5 GB free database a table
        // that only grows is a problem that arrives months later, looking like
        // something else.
        this.sweepTimer = setInterval(() => {
            this.clearExpired().catch((error) =>
                console.error('[session] Could not clear expired sessions:', error.message));
        }, SWEEP_INTERVAL_MS);

        // Unreferenced, so a one-shot script (npm run diagnose, search:index)
        // still exits when its work is done instead of hanging on this timer.
        if (this.sweepTimer.unref) this.sweepTimer.unref();
    }

    /** When this session should stop being valid. */
    expiryFor(sess) {
        const cookieExpiry = sess?.cookie?.expires;
        if (cookieExpiry) return new Date(cookieExpiry).getTime();
        const maxAge = sess?.cookie?.maxAge;
        return Date.now() + (typeof maxAge === 'number' ? maxAge : this.ttlMs);
    }

    async run(work, callback) {
        try {
            await this.ready;
            const result = await work();
            if (callback) callback(null, result);
        } catch (error) {
            if (callback) callback(error);
            else console.error('[session] Store error:', error.message);
        }
    }

    get(sessionId, callback) {
        this.run(async () => {
            const [rows] = await db.query(
                `SELECT data, expiresAt FROM ${TABLE} WHERE sessionId = ?`, [sessionId]);
            if (!rows.length) return null;
            if (Number(rows[0].expiresAt) <= Date.now()) {
                await db.query(`DELETE FROM ${TABLE} WHERE sessionId = ?`, [sessionId]);
                return null;
            }
            try {
                return JSON.parse(rows[0].data);
            } catch {
                // A row that cannot be parsed is worse than no row: it would
                // throw on every request from that visitor until the cookie
                // expired. Drop it and let them get a fresh session.
                await db.query(`DELETE FROM ${TABLE} WHERE sessionId = ?`, [sessionId]);
                return null;
            }
        }, callback);
    }

    set(sessionId, sess, callback) {
        this.run(async () => {
            await db.query(
                `INSERT INTO ${TABLE} (sessionId, expiresAt, data) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE expiresAt = VALUES(expiresAt), data = VALUES(data)`,
                [sessionId, this.expiryFor(sess), JSON.stringify(sess)]
            );
        }, callback);
    }

    /**
     * Push the expiry out without rewriting the payload. `rolling: true` calls
     * this on every single request, so it is the hottest query in the app -
     * writing the whole session back each time would be pure waste.
     */
    touch(sessionId, sess, callback) {
        this.run(async () => {
            await db.query(
                `UPDATE ${TABLE} SET expiresAt = ? WHERE sessionId = ?`,
                [this.expiryFor(sess), sessionId]
            );
        }, callback);
    }

    destroy(sessionId, callback) {
        this.run(() => db.query(`DELETE FROM ${TABLE} WHERE sessionId = ?`, [sessionId]), callback);
    }

    length(callback) {
        this.run(async () => {
            const [[row]] = await db.query(
                `SELECT COUNT(*) AS count FROM ${TABLE} WHERE expiresAt > ?`, [Date.now()]);
            return Number(row.count);
        }, callback);
    }

    clear(callback) {
        this.run(() => db.query(`DELETE FROM ${TABLE}`), callback);
    }

    all(callback) {
        this.run(async () => {
            const [rows] = await db.query(
                `SELECT sessionId, data FROM ${TABLE} WHERE expiresAt > ?`, [Date.now()]);
            const out = {};
            for (const row of rows) {
                try { out[row.sessionId] = JSON.parse(row.data); } catch { /* skip a corrupt row */ }
            }
            return out;
        }, callback);
    }

    /** Remove everything that has already expired. Returns how many went. */
    async clearExpired() {
        await this.ready;
        const [result] = await db.query(`DELETE FROM ${TABLE} WHERE expiresAt <= ?`, [Date.now()]);
        return result.affectedRows || 0;
    }

    /** Stop the sweep timer - for tests and clean shutdowns. */
    close() {
        clearInterval(this.sweepTimer);
    }
}
