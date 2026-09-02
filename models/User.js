import db from './db.js';
import bcrypt from 'bcrypt';

class User {
    /**
     * Find a user by username
     * @param {string} username 
     * @returns {Promise<Object|null>}
     */
    static async findByUsername(username) {
        try {
            const query = 'SELECT * FROM Users WHERE username = ?';
            const [results] = await db.query(query, [username]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding user by username: ${error.message}`);
        }
    }

    /**
     * Find a user by email (used by Google sign-in, which identifies people
     * by email rather than username).
     * @param {string} email
     * @returns {Promise<Object|null>}
     */
    static async findByEmail(email) {
        try {
            const query = 'SELECT * FROM Users WHERE email = ?';
            const [results] = await db.query(query, [email]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding user by email: ${error.message}`);
        }
    }

    /**
     * Find a user by ID
     * @param {number} id
     * @returns {Promise<Object|null>}
     */
    static async findById(id) {
        try {
            const query = 'SELECT * FROM Users WHERE userId = ?';
            const [results] = await db.query(query, [id]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding user by ID: ${error.message}`);
        }
    }

    /**
     * Create a new user
     * @param {Object} userData - {name, username, email, password}
     * @returns {Promise<Object>} - Created user data
     */
    static async create(userData) {
        try {
            const { name, username, email, password } = userData;

            // Hash password
            const hashedPassword = await bcrypt.hash(password, 10);

            const query = 'INSERT INTO Users (name, username, email, password) VALUES (?, ?, ?, ?)';
            const [result] = await db.query(query, [name, username, email, hashedPassword]);

            return {
                userId: result.insertId,
                name,
                username,
                email
            };
        } catch (error) {
            // Check for duplicate entry
            if (error.code === 'ER_DUP_ENTRY') {
                throw new Error('Username or email already exists');
            }
            throw new Error(`Error creating user: ${error.message}`);
        }
    }

    /**
     * Verify a password against the stored value.
     *
     * Legacy rows: this used to end with `return password === hash;` as a
     * fallback, which meant a plain-text password in the database stayed
     * usable forever - the row was never upgraded, so the weakness was
     * permanent, and anyone who ever saw a database dump had working
     * credentials. It now mirrors what Admin.verifyPassword already does:
     * accept the plain-text value ONCE, then immediately replace it with a
     * bcrypt hash, so the account self-heals on the owner's next login and
     * no plain-text password can survive in the table.
     *
     * @param {string} password - Plain text password from the login form
     * @param {string} hash - Value stored in Users.password
     * @param {number} [userId] - Row id; enables the one-time upgrade
     * @returns {Promise<boolean>}
     */
    static async verifyPassword(password, hash, userId) {
        try {
            const stored = hash || '';
            // bcrypt hashes always start $2a$ / $2b$ / $2y$.
            const looksHashed = /^\$2[aby]\$/.test(stored);

            if (looksHashed) {
                return await bcrypt.compare(password, stored);
            }

            // Not a bcrypt hash - a legacy plain-text row.
            const matches = password === stored && stored !== '';
            if (matches && userId) {
                const newHash = await bcrypt.hash(password, 10);
                await db.query('UPDATE Users SET password = ? WHERE userId = ?', [newHash, userId]);
                console.warn(`[auth] Upgraded legacy plain-text password to bcrypt for userId ${userId}.`);
            }
            return matches;
        } catch (error) {
            throw new Error(`Error verifying password: ${error.message}`);
        }
    }

    /**
     * Replace a user's password with a new bcrypt hash.
     * Hashing happens here so no caller can ever accidentally store plain text.
     * @param {number} userId
     * @param {string} newPassword - plain text; hashed before it is written
     * @returns {Promise<boolean>}
     */
    static async updatePassword(userId, newPassword) {
        try {
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            const [result] = await db.query(
                'UPDATE Users SET password = ? WHERE userId = ?',
                [hashedPassword, userId]
            );
            return result.affectedRows > 0;
        } catch (error) {
            throw new Error(`Error updating password: ${error.message}`);
        }
    }

    /**
     * Get all users (for admin or messaging)
     * @returns {Promise<Array>}
     */
    static async getAll() {
        try {
            const query = 'SELECT userId, username, name, email FROM Users';
            const [results] = await db.query(query);
            return results;
        } catch (error) {
            throw new Error(`Error getting all users: ${error.message}`);
        }
    }

    /**
     * Delete a user by ID
     * @param {number} userId 
     * @returns {Promise<boolean>}
     */
    static async delete(userId) {
        try {
            const query = 'DELETE FROM Users WHERE userId = ?';
            const [result] = await db.query(query, [userId]);
            return result.affectedRows > 0;
        } catch (error) {
            throw new Error(`Error deleting user: ${error.message}`);
        }
    }

    /**
     * Get user statistics (for admin dashboard)
     * @returns {Promise<Array>}
     */
    static async getUserStats() {
        try {
            const query = `
        SELECT userId, name, email, username,
          (SELECT COUNT(*) FROM Files WHERE uploadedBy = u.userId) AS fileCount,
          -- Comments are stored in the chats table (models/Chat.js). This
          -- counted rows in an unrelated Comments table the app never writes
          -- to, so every user's comment count on the admin dashboard was
          -- permanently 0.
          (SELECT COUNT(*) FROM chats WHERE userID = u.userId) AS commentCount,
          (SELECT COUNT(*) FROM messages WHERE sender_id = u.userId) AS sendMsg,
          (SELECT COUNT(*) FROM messages WHERE receiver_id = u.userId) AS receiveMsg
        FROM Users u
      `;
            const [results] = await db.query(query);
            return results;
        } catch (error) {
            throw new Error(`Error getting user stats: ${error.message}`);
        }
    }
}

export default User;
