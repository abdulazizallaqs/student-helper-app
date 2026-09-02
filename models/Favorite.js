import db from './db.js';

class Favorite {
    /**
     * Get all favorites for a user
     * @param {number} userId 
     * @returns {Promise<Array>}
     */
    static async findByUser(userId) {
        try {
            const query = `
        SELECT Favorit.favoritId, Files.id, Files.title, Files.description, 
               Users.username AS uploader, Categories.name AS category
        FROM Files
        JOIN Categories ON Files.categoryID = Categories.id
        INNER JOIN Favorit ON Files.id = Favorit.fileId
        INNER JOIN Users ON Files.uploadedBy = Users.userId
        WHERE Favorit.userId = ?
      `;
            const [results] = await db.query(query, [userId]);
            return results;
        } catch (error) {
            throw new Error(`Error finding favorites: ${error.message}`);
        }
    }

    /**
     * Add a file to favorites
     * @param {number} userId 
     * @param {number} fileId 
     * @returns {Promise<Object>}
     */
    static async add(userId, fileId) {
        try {
            const [existing] = await db.query(
                'SELECT favoritId FROM Favorit WHERE userId = ? AND fileId = ?',
                [userId, fileId]
            );
            if (existing.length > 0) {
                return { favoritId: existing[0].favoritId, userId, fileId, alreadyExists: true };
            }

            const query = 'INSERT INTO Favorit (userid, fileid) VALUES (?, ?)';
            const [result] = await db.query(query, [userId, fileId]);

            return {
                favoritId: result.insertId,
                userId,
                fileId,
                alreadyExists: false
            };
        } catch (error) {
            // The SELECT above is only a fast path. Two concurrent requests (a
            // double-click, or a retry) can both pass it and both reach the
            // INSERT - that is how duplicate favorites ended up in the list.
            // The UNIQUE KEY on (userId, fileId) now rejects the loser, and
            // that rejection means "already favorited", which is precisely the
            // alreadyExists case rather than a failure worth reporting.
            if (error.code === 'ER_DUP_ENTRY') {
                const [existing] = await db.query(
                    'SELECT favoritId FROM Favorit WHERE userId = ? AND fileId = ?',
                    [userId, fileId]
                );
                return {
                    favoritId: existing[0]?.favoritId,
                    userId,
                    fileId,
                    alreadyExists: true
                };
            }
            throw new Error(`Error adding to favorites: ${error.message}`);
        }
    }

    /**
     * Remove a file from favorites. Scoped to userId so one user can't delete
     * another user's favorite by guessing/incrementing a favoritId.
     * @param {number} favoritId 
     * @param {number} userId 
     * @returns {Promise<boolean>}
     */
    static async remove(favoritId, userId) {
        try {
            const query = 'DELETE FROM Favorit WHERE favoritId = ? AND userId = ?';
            const [result] = await db.query(query, [favoritId, userId]);
            return result.affectedRows > 0;
        } catch (error) {
            throw new Error(`Error removing from favorites: ${error.message}`);
        }
    }
}

export default Favorite;
