import db from './db.js';

/**
 * WHY THIS FILE INTROSPECTS THE TABLE INSTEAD OF HARDCODING COLUMN NAMES
 * ---------------------------------------------------------------------
 * Every messaging endpoint was answering 500, and the browser console only
 * showed "Failed to load conversations" / "Failed to load thread". The cause
 * was not the JavaScript: the SQL below referenced columns (`id`, `sent_at`)
 * that this deployment's `messages` table does not necessarily have. The
 * project has never had a committed schema file - the table was created by
 * hand - so the code and the database had simply drifted apart, and MySQL
 * answered `ER_BAD_FIELD_ERROR`, which surfaced as a bare 500.
 *
 * Rather than guess again, the shape of the table is read once from
 * information_schema and every query is built from the columns that are
 * really there:
 *
 *   - a message id column is used for tie-breaking when it exists, and
 *     quietly skipped when it does not;
 *   - the "when was this sent" column is matched against the handful of
 *     names this table is realistically called (sent_at, sentDate, ...);
 *   - if sender/receiver/content genuinely cannot be found, the error says
 *     exactly which column is missing and how to fix it, instead of 500.
 *
 * Column names come from information_schema for THIS database - they are
 * never user input - and they are back-quoted where they are interpolated.
 *
 * `npm run db:repair` creates or completes the table to the shape the rest
 * of the app expects.
 */

const REPAIR_HINT = 'Run "npm run db:repair" to create or complete it, then "npm run diagnose" to confirm.';

/** An error the API layer can turn into a clear message for the user. */
function schemaError(message) {
  const error = new Error(message);
  error.code = 'SCHEMA_MISMATCH';
  return error;
}

let shapePromise = null;

/**
 * Read the real column names of `messages`, once per process.
 * @returns {Promise<{id: string|null, sender: string, receiver: string, content: string, sentAt: string|null}>}
 */
function messagesShape() {
  if (!shapePromise) {
    shapePromise = (async () => {
      const [columns] = await db.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = 'messages'`
      );

      if (columns.length === 0) {
        throw schemaError(
          `The "messages" table does not exist in this database, so messaging cannot work. ${REPAIR_HINT}`
        );
      }

      const byLower = new Map(columns.map((c) => [c.COLUMN_NAME.toLowerCase(), c.COLUMN_NAME]));
      const pick = (...candidates) => {
        for (const candidate of candidates) {
          const found = byLower.get(candidate.toLowerCase());
          if (found) return found;
        }
        return null;
      };

      const shape = {
        id: pick('id', 'messageId', 'message_id', 'msgId', 'msg_id'),
        sender: pick('sender_id', 'senderId', 'sender', 'from_id', 'fromId'),
        receiver: pick('receiver_id', 'receiverId', 'receiver', 'to_id', 'toId'),
        content: pick('content', 'message', 'text', 'body'),
        sentAt: pick('sent_at', 'sentDate', 'sent_date', 'created_at', 'createdAt', 'date', 'timestamp'),
      };

      const missing = [];
      if (!shape.sender) missing.push('sender_id');
      if (!shape.receiver) missing.push('receiver_id');
      if (!shape.content) missing.push('content');

      if (missing.length) {
        throw schemaError(
          `The "messages" table is missing the column(s): ${missing.join(', ')}. ` +
          `It currently has: ${columns.map((c) => c.COLUMN_NAME).join(', ')}. ${REPAIR_HINT}`
        );
      }

      return shape;
    })().catch((error) => {
      // Don't cache a transient failure (e.g. the database was down at boot) -
      // only a genuine schema mismatch is worth remembering.
      if (error.code !== 'SCHEMA_MISMATCH') shapePromise = null;
      throw error;
    });
  }
  return shapePromise;
}

/** Re-read the table shape on the next query (used by tests and db:repair). */
export function resetMessagesShapeCache() {
  shapePromise = null;
}

/**
 * "Newest first" / "oldest first" fragments built from whatever ordering
 * columns this table actually has. sent_at is only second-precision, so the
 * id breaks ties when it exists - two messages sent in the same second would
 * otherwise come back in an arbitrary order.
 */
function orderBy(shape, alias, direction) {
  const prefix = alias ? `${alias}.` : '';
  const parts = [];
  if (shape.sentAt) parts.push(`${prefix}\`${shape.sentAt}\` ${direction}`);
  if (shape.id) parts.push(`${prefix}\`${shape.id}\` ${direction}`);
  return parts.length ? `ORDER BY ${parts.join(', ')}` : '';
}

/** `sent_at`, or NULL under that name when the table has no timestamp column. */
function sentAtSelect(shape, alias, as) {
  const prefix = alias ? `${alias}.` : '';
  return shape.sentAt ? `${prefix}\`${shape.sentAt}\` AS ${as}` : `NULL AS ${as}`;
}

class Message {
    /**
     * Get messages sent by a user
     * @param {number} userId
     * @returns {Promise<Array>}
     */
    static async findSentBy(userId) {
        try {
            const s = await messagesShape();
            const query = `
        SELECT c.\`${s.content}\` AS content, ${sentAtSelect(s, 'c', 'sentDate')}, Users.username AS receiver
        FROM messages c
        JOIN Users ON c.\`${s.receiver}\` = Users.userId
        WHERE c.\`${s.sender}\` = ?
        ${orderBy(s, 'c', 'DESC')}
      `;
            const [results] = await db.query(query, [userId]);
            return results;
        } catch (error) {
            if (error.code === 'SCHEMA_MISMATCH') throw error;
            throw new Error(`Error finding sent messages: ${error.message}`);
        }
    }

    /**
     * Get messages received by a user
     * @param {number} userId
     * @returns {Promise<Array>}
     */
    static async findReceivedBy(userId) {
        try {
            const s = await messagesShape();
            const query = `
        SELECT c.\`${s.content}\` AS content, ${sentAtSelect(s, 'c', 'sentDate')}, Users.username AS sender
        FROM messages c
        JOIN Users ON c.\`${s.sender}\` = Users.userId
        WHERE c.\`${s.receiver}\` = ?
        ${orderBy(s, 'c', 'DESC')}
      `;
            const [results] = await db.query(query, [userId]);
            return results;
        } catch (error) {
            if (error.code === 'SCHEMA_MISMATCH') throw error;
            throw new Error(`Error finding received messages: ${error.message}`);
        }
    }

    /**
     * List the people the user has exchanged messages with, each annotated
     * with the most recent message and when it was sent - for a Telegram-
     * style conversation list, newest conversation first.
     * @param {number} userId
     * @returns {Promise<Array>}
     */
    static async findConversationPartners(userId) {
        try {
            const s = await messagesShape();
            const between = `((m2.\`${s.sender}\` = ? AND m2.\`${s.receiver}\` = other.userId)
                           OR (m2.\`${s.sender}\` = other.userId AND m2.\`${s.receiver}\` = ?))`;
            const newest = orderBy(s, 'm2', 'DESC');

            const query = `
        SELECT other.userId, other.username, other.name,
          (SELECT m2.\`${s.content}\` FROM messages m2 WHERE ${between} ${newest} LIMIT 1) AS lastMessage,
          (SELECT ${s.sentAt ? `m2.\`${s.sentAt}\`` : 'NULL'} FROM messages m2 WHERE ${between} ${newest} LIMIT 1) AS lastMessageAt
          ${s.id ? `, (SELECT m2.\`${s.id}\` FROM messages m2 WHERE ${between} ${newest} LIMIT 1) AS lastMessageId` : ''}
        FROM Users other
        WHERE other.userId IN (
          SELECT \`${s.receiver}\` FROM messages WHERE \`${s.sender}\` = ?
          UNION
          SELECT \`${s.sender}\` FROM messages WHERE \`${s.receiver}\` = ?
        )
        ORDER BY lastMessageAt DESC${s.id ? ', lastMessageId DESC' : ''}
      `;

            // Two placeholders per correlated sub-select, then two for the IN list.
            const perSubquery = 2;
            const subqueries = s.id ? 3 : 2;
            const params = Array(perSubquery * subqueries).fill(userId).concat([userId, userId]);

            const [results] = await db.query(query, params);
            return results;
        } catch (error) {
            if (error.code === 'SCHEMA_MISMATCH') throw error;
            throw new Error(`Error finding conversation partners: ${error.message}`);
        }
    }

    /**
     * The full back-and-forth between the current user and one other user,
     * oldest first, each message tagged with whether the current user sent
     * or received it - a merged conversation thread.
     * @param {number} userId - the current (logged-in) user
     * @param {number} otherUserId - the other party in the conversation
     * @returns {Promise<Array>}
     */
    static async findThread(userId, otherUserId) {
        try {
            const s = await messagesShape();
            const query = `
        SELECT ${s.id ? `\`${s.id}\` AS id,` : ''}
               \`${s.sender}\` AS sender_id,
               \`${s.receiver}\` AS receiver_id,
               \`${s.content}\` AS content,
               ${sentAtSelect(s, '', 'sent_at')}
        FROM messages
        WHERE (\`${s.sender}\` = ? AND \`${s.receiver}\` = ?)
           OR (\`${s.sender}\` = ? AND \`${s.receiver}\` = ?)
        ${orderBy(s, '', 'ASC')}
      `;
            const [results] = await db.query(query, [userId, otherUserId, otherUserId, userId]);
            return results.map((m, index) => ({
                // Without a real id column the client still needs a stable key
                // per message; its position in the thread serves for that.
                id: m.id ?? index,
                content: m.content,
                sentAt: m.sent_at,
                direction: Number(m.sender_id) === Number(userId) ? 'sent' : 'received'
            }));
        } catch (error) {
            if (error.code === 'SCHEMA_MISMATCH') throw error;
            throw new Error(`Error finding conversation thread: ${error.message}`);
        }
    }

    /**
     * Create a new message
     * @param {Object} messageData - {sender_id, receiver_id, content}
     * @returns {Promise<Object>}
     */
    static async create(messageData) {
        try {
            const s = await messagesShape();
            const { sender_id, receiver_id, content } = messageData;
            const query =
              `INSERT INTO messages (\`${s.sender}\`, \`${s.receiver}\`, \`${s.content}\`) VALUES (?, ?, ?)`;
            const [result] = await db.query(query, [sender_id, receiver_id, content]);

            return {
                id: result.insertId,
                ...messageData
            };
        } catch (error) {
            if (error.code === 'SCHEMA_MISMATCH') throw error;
            throw new Error(`Error creating message: ${error.message}`);
        }
    }
}

export default Message;
