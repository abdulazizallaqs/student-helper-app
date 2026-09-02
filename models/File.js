import db from './db.js';
import { parseQuery, likePatterns, rankFiles } from '../services/searchService.js';
import { embedQuery, cosine } from '../services/embeddingService.js';
import FileEmbedding from './FileEmbedding.js';

// How many rows the SQL net may return before ranking, and how many rows the
// typo fallback is allowed to scan. Both are guard rails: search must stay
// cheap on a library that has grown, and the ranking is O(rows x terms).
const CANDIDATE_LIMIT = 300;
const FUZZY_SCAN_LIMIT = 400;
const FUZZY_FALLBACK_THRESHOLD = 3;
// How many embedded files may join the pool on a semantic search. Comparing
// vectors is a few hundred multiplications each - cheap, but not free.
const EMBEDDING_SCAN_LIMIT = parseInt(process.env.SEARCH_EMBEDDING_SCAN_LIMIT || '400', 10);

const SEARCH_SELECT = `
  SELECT Files.id, Files.title, Files.description, Files.categoryID, Users.username,
         Categories.name AS category
  FROM Files
  JOIN Categories ON Files.categoryID = Categories.id
  JOIN Users ON Files.uploadedBy = Users.userId`;

class File {
    /**
     * Create a new file record
     * @param {Object} fileData - {categoryID, title, description, uploadedBy}
     * @returns {Promise<Object>}
     */
    static async create(fileData) {
        try {
            const { categoryID, title, description, uploadedBy } = fileData;
            const query = 'INSERT INTO Files (categoryID, title, description, uploadedBy) VALUES (?, ?, ?, ?)';
            const [result] = await db.query(query, [categoryID, title, description, uploadedBy]);

            return {
                id: result.insertId,
                ...fileData
            };
        } catch (error) {
            throw new Error(`Error creating file: ${error.message}`);
        }
    }

    /**
     * Find file by ID
     * @param {number} id 
     * @returns {Promise<Object|null>}
     */
    static async findById(id) {
        try {
            const query = `
        SELECT Files.id, Files.title, Files.description, Files.categoryID, Files.uploadedBy, 
               Categories.name AS category
        FROM Files
        JOIN Categories ON Files.categoryID = Categories.id
        WHERE Files.id = ?
      `;
            const [results] = await db.query(query, [id]);
            return results.length > 0 ? results[0] : null;
        } catch (error) {
            throw new Error(`Error finding file: ${error.message}`);
        }
    }

    /**
     * Get files uploaded by a specific user
     * @param {number} userId 
     * @returns {Promise<Array>}
     */
    static async findByUser(userId) {
        try {
            const query = `
        SELECT Files.id, Files.title, Files.description, Users.username, Categories.name AS category
        FROM Files
        JOIN Categories ON Files.categoryID = Categories.id
        INNER JOIN Users ON Files.uploadedBy = Users.userId
        WHERE Files.uploadedBy = ?
      `;
            const [results] = await db.query(query, [userId]);
            return results;
        } catch (error) {
            throw new Error(`Error finding files by user: ${error.message}`);
        }
    }

    /**
     * Get files uploaded by other users
     * @param {number} userId - Current user ID to exclude
     * @returns {Promise<Array>}
     */
    static async findByOthers(userId) {
        try {
            const query = `
        SELECT Files.id, Files.title, Files.description, Users.username, Categories.name AS category
        FROM Files
        JOIN Categories ON Files.categoryID = Categories.id
        INNER JOIN Users ON Files.uploadedBy = Users.userId
        WHERE Files.uploadedBy != ?
      `;
            const [results] = await db.query(query, [userId]);
            return results;
        } catch (error) {
            throw new Error(`Error finding files by others: ${error.message}`);
        }
    }

    /**
     * Get all files (for admin)
     * @returns {Promise<Array>}
     */
    static async getAll() {
        try {
            const query = `
        SELECT f.id, f.title, f.description, c.name AS category, u.name AS userName
        FROM Files f
        JOIN Categories c ON f.categoryID = c.id
        JOIN Users u ON f.uploadedBy = u.userId
      `;
            const [results] = await db.query(query);
            return results;
        } catch (error) {
            throw new Error(`Error getting all files: ${error.message}`);
        }
    }

    /**
     * Update file details.
     *
     * SECURITY: `userId` is REQUIRED and the UPDATE is scoped to
     * `uploadedBy = userId`. Without that scoping any logged-in user could
     * overwrite the title/description/category of ANY other user's file just
     * by putting that file's id in the URL - this was confirmed exploitable
     * before the scoping was added. Mirrors how `delete` has always worked.
     *
     * @param {number} id
     * @param {Object} updates - {title, description, categoryID}
     * @param {number} userId - owner id; rows not owned by them are untouched
     * @returns {Promise<boolean>} false if the file doesn't exist OR isn't theirs
     */
    static async update(id, updates, userId) {
        if (!userId) {
            throw new Error('Error updating file: missing owner id');
        }
        try {
            const fields = [];
            const values = [];

            if (updates.title) {
                fields.push('title = ?');
                values.push(updates.title);
            }
            if (updates.description) {
                fields.push('description = ?');
                values.push(updates.description);
            }
            if (updates.categoryID) {
                fields.push('categoryID = ?');
                values.push(updates.categoryID);
            }

            if (fields.length === 0) {
                throw new Error('No fields to update');
            }

            values.push(id, userId);
            const query = `UPDATE Files SET ${fields.join(', ')} WHERE id = ? AND uploadedBy = ?`;
            const [result] = await db.query(query, values);

            return result.affectedRows > 0;
        } catch (error) {
            throw new Error(`Error updating file: ${error.message}`);
        }
    }

    /**
     * Delete a file (scoped to its owner).
     *
     * Returns null instead of throwing when the file doesn't exist or isn't
     * the caller's, so the controller can answer 404 rather than turning an
     * ordinary "not yours" into a 500 with an internal message attached.
     *
     * @param {number} id
     * @param {number} userId - User ID for ownership verification
     * @returns {Promise<Object|null>} - {success, title} or null
     */
    static async delete(id, userId) {
        try {
            // First get file info for ownership check and filename
            const getFileQuery = 'SELECT title FROM Files WHERE uploadedBy = ? AND id = ?';
            const [results] = await db.query(getFileQuery, [userId, id]);

            if (results.length === 0) {
                return null;
            }

            const fileTitle = results[0].title;

            // Delete from database
            const deleteQuery = 'DELETE FROM Files WHERE uploadedBy = ? AND id = ?';
            await db.query(deleteQuery, [userId, id]);

            return { success: true, title: fileTitle };
        } catch (error) {
            throw new Error(`Error deleting file: ${error.message}`);
        }
    }

    /**
     * Search files by query
     * @param {string} searchQuery 
     * @returns {Promise<Array>}
     */
    static async search(searchQuery) {
        const parsed = parseQuery(searchQuery);
        if (!parsed.terms.length) return [];

        try {
            // THREE passes, each answering a question the one before it cannot.
            //
            //  1. SQL casts a wide net - every term, plus its stem and its
            //     synonyms, against every searchable column. Fast, and it
            //     finds anything that shares vocabulary with the query.
            //  2. If that net comes back nearly empty, a bounded scan of the
            //     library lets edit distance catch misspellings, which a LIKE
            //     can never match.
            //  3. If embeddings are available, the files that have one are
            //     pulled in too, so a file can be found by MEANING even when
            //     it shares no word with what was typed.
            //
            // The ranking that decides the order of all of it is done in JS
            // (services/searchService.js): it needs Arabic normalisation, a
            // bilingual thesaurus, edit distance, inverse document frequency
            // and cosine similarity, none of which MySQL has.
            const patterns = likePatterns(parsed);
            const where = patterns
                .map(() => '(Files.title LIKE ? OR Files.description LIKE ? OR Categories.name LIKE ? OR Users.username LIKE ?)')
                .join(' OR ');
            const params = patterns.flatMap((pattern) => [pattern, pattern, pattern, pattern]);

            // The query vector is fetched alongside the candidates rather than
            // after them: the network call and the database call have nothing
            // to say to each other, so making them wait in turn would add the
            // slower one's latency to every search for nothing.
            const [[candidates], [[{ total }]], queryVector] = await Promise.all([
                db.query(`${SEARCH_SELECT} WHERE ${where} LIMIT ${CANDIDATE_LIMIT}`, params),
                db.query('SELECT COUNT(*) AS total FROM Files'),
                embedQuery(searchQuery)
            ]);

            const byId = new Map(candidates.map((row) => [Number(row.id), row]));

            // Fuzzy fallback: 'thermodyanmics' contains no substring of
            // 'thermodynamics', so pass 1 returned nothing at all.
            if (byId.size < FUZZY_FALLBACK_THRESHOLD) {
                const [recent] = await db.query(`${SEARCH_SELECT} ORDER BY Files.id DESC LIMIT ${FUZZY_SCAN_LIMIT}`);
                for (const row of recent) if (!byId.has(Number(row.id))) byId.set(Number(row.id), row);
            }

            if (queryVector) {
                // Everything with a vector joins the pool, so a purely
                // semantic match can win a place it could never have earned
                // on words. Rows already present just get their vector.
                for (const row of await FileEmbedding.findEmbeddedFiles(EMBEDDING_SCAN_LIMIT)) {
                    const existing = byId.get(Number(row.id));
                    if (existing) existing._vector = row._vector;
                    else byId.set(Number(row.id), row);
                }
                // Candidates outside that window still deserve their vector.
                const unvectored = [...byId.values()].filter((row) => !row._vector).map((row) => row.id);
                if (unvectored.length) {
                    const vectors = await FileEmbedding.findByFileIds(unvectored);
                    for (const [id, vector] of vectors) {
                        const row = byId.get(Number(id));
                        if (row) row._vector = vector;
                    }
                }
            }

            return rankFiles([...byId.values()], searchQuery, {
                corpusSize: Number(total) || byId.size,
                queryVector,
                cosine
            });
        } catch (error) {
            throw new Error(`Error searching files: ${error.message}`);
        }
    }

    /**
     * Get all categories
     * @returns {Promise<Array>}
     */
    static async getCategories() {
        try {
            const query = 'SELECT id, name FROM Categories ORDER BY name ASC';
            const [results] = await db.query(query);
            return results;
        } catch (error) {
            throw new Error(`Error getting categories: ${error.message}`);
        }
    }

    /**
     * Return the id of the category with this name, creating it if it does
     * not exist yet. Backs the "add a new category while uploading" flow.
     *
     * Matching is case-insensitive and ignores surrounding whitespace, so
     * "Physics", "physics" and " Physics " all resolve to one category
     * instead of quietly creating three that look identical in the dropdown.
     *
     * @param {string} name
     * @returns {Promise<{id:number, name:string, created:boolean}>}
     */
    static async findOrCreateCategory(name) {
        const cleaned = String(name ?? '').trim().replace(/\s+/g, ' ');
        if (!cleaned) {
            throw new Error('Error creating category: name is empty');
        }
        try {
            const [existing] = await db.query(
                'SELECT id, name FROM Categories WHERE LOWER(name) = LOWER(?) LIMIT 1',
                [cleaned]
            );
            if (existing.length > 0) {
                return { id: existing[0].id, name: existing[0].name, created: false };
            }

            const [result] = await db.query('INSERT INTO Categories (name) VALUES (?)', [cleaned]);
            return { id: result.insertId, name: cleaned, created: true };
        } catch (error) {
            // Two uploads inventing the same new category at the same moment
            // race between the SELECT and the INSERT. If the table has a
            // unique index on name the loser lands here; re-reading gives it
            // the winner's row rather than failing the upload.
            if (error.code === 'ER_DUP_ENTRY') {
                const [row] = await db.query(
                    'SELECT id, name FROM Categories WHERE LOWER(name) = LOWER(?) LIMIT 1',
                    [cleaned]
                );
                if (row.length > 0) return { id: row[0].id, name: row[0].name, created: false };
            }
            throw new Error(`Error creating category: ${error.message}`);
        }
    }
}

export default File;
