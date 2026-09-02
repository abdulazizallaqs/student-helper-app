import db from './db.js';

class Chat {
    /**
     * Get all chats for a specific file
     * @param {number} fileId 
     * @returns {Promise<Array>}
     */
    static async findByFile(fileId) {
        try {
            const query = `
        SELECT c.content, c.chatDate, u.username
        FROM chats c
        INNER JOIN Users u ON c.userID = u.userId
        WHERE c.fileID = ?
        ORDER BY c.chatDate ASC
      `;
            const [results] = await db.query(query, [fileId]);
            return results;
        } catch (error) {
            throw new Error(`Error finding chats: ${error.message}`);
        }
    }

    /**
     * Create a new chat message
     * @param {Object} chatData - {fileID, content, userID}
     * @returns {Promise<Object>}
     */
    static async create(chatData) {
        try {
            const { fileID, content, userID } = chatData;
            const query = 'INSERT INTO chats (fileID, content, userID) VALUES (?, ?, ?)';
            const [result] = await db.query(query, [fileID, content, userID]);

            return {
                id: result.insertId,
                ...chatData
            };
        } catch (error) {
            throw new Error(`Error creating chat: ${error.message}`);
        }
    }
}

export default Chat;
