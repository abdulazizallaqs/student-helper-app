import db from './db.js';
import bcrypt from 'bcrypt';

class Admin {
    /**
     * Find an admin by username
     * @param {string} username
     * @returns {Promise<Object|null>}
     */
    static async findByUsername(username) {
        try {
            const query = 'SELECT * FROM Admin WHERE username = ?';
            const [results] = await db.query(query, [username]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding admin by username: ${error.message}`);
        }
    }

    /**
     * Find an admin by ID
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    static async findById(id) {
        try {
            const query = 'SELECT * FROM Admin WHERE adminId = ?';
            const [results] = await db.query(query, [id]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding admin by ID: ${error.message}`);
        }
    }

    /**
     * Verify a password against the stored admin record, transparently
     * upgrading a legacy plain-text password to a bcrypt hash on a
     * successful match (mirrors the pattern previously inlined in
     * routes/loginAdminRoute.js).
     * @param {Object} admin - row returned by findByUsername
     * @param {string} password - plain text password from the login form
     * @returns {Promise<boolean>}
     */
    static async verifyPassword(admin, password) {
        try {
            const storedPassword = admin.password || '';
            const looksHashed = /^\$2[aby]\$/.test(storedPassword);

            if (looksHashed) {
                return await bcrypt.compare(password, storedPassword);
            }

            const matches = password === storedPassword;
            if (matches) {
                const newHash = await bcrypt.hash(password, 10);
                await db.query('UPDATE Admin SET password = ? WHERE adminId = ?', [newHash, admin.adminId]);
            }
            return matches;
        } catch (error) {
            throw new Error(`Error verifying admin password: ${error.message}`);
        }
    }
}

export default Admin;
