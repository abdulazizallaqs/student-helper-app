import Message from '../models/Message.js';
import User from '../models/User.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * A mismatch between the code and the actual `messages` table is a
 * configuration problem the person running the app can fix, not an internal
 * detail to hide. The generic 500 handler deliberately strips error messages
 * (they can leak database internals), which is why these endpoints answered a
 * bare "Something went wrong" while the console showed nothing useful.
 * models/Message.js tags this one case, and it is answered with 503 plus the
 * exact remedy.
 */
function handleMessageError(error, res, next) {
    if (error.code === 'SCHEMA_MISMATCH') {
        console.error('[messages] Database schema problem:', error.message);
        return res.status(503).json({ error: 'schema', message: error.message });
    }
    return next(new AppError(error.message, 500));
}

const messageController = {
    /**
     * Get messages sent by user
     */
    getSentMessages: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const messages = await Message.findSentBy(userId);
            res.json(messages);
        } catch (error) {
            handleMessageError(error, res, next);
        }
    },

    /**
     * Get messages received by user
     */
    getReceivedMessages: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const messages = await Message.findReceivedBy(userId);
            res.json(messages);
        } catch (error) {
            handleMessageError(error, res, next);
        }
    },

    /**
     * List conversation partners (for the Telegram-style chat list)
     */
    getConversations: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const conversations = await Message.findConversationPartners(userId);
            res.json(conversations);
        } catch (error) {
            handleMessageError(error, res, next);
        }
    },

    /**
     * Get the merged conversation thread with one other user
     */
    getThread: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const otherUserId = parseInt(req.params.userId, 10);
            if (!Number.isInteger(otherUserId)) {
                return res.status(400).json({ error: 'Invalid user id' });
            }

            const thread = await Message.findThread(userId, otherUserId);
            res.json(thread);
        } catch (error) {
            handleMessageError(error, res, next);
        }
    },

    /**
     * Get all users (for messaging)
     */
    getUsers: async (req, res, next) => {
        try {
            // Returns every user's name, username and email - the whole user
            // directory. It exists only to fill the "send a message to..."
            // picker for someone already logged in. Without this check an
            // anonymous `GET /msg` dumped the entire Users table (PII) to
            // anyone who asked: messageRoutes is mounted ahead of app.js's
            // catch-all session gate, so nothing else was stopping it.
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const users = await User.getAll();
            res.json(users);
        } catch (error) {
            handleMessageError(error, res, next);
        }
    },

    /**
     * Send a message
     */
    sendMessage: async (req, res, next) => {
        try {
            const { receiver, content } = req.body;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            await Message.create({
                sender_id: userId,
                receiver_id: receiver,
                content
            });

            res.json({ success: true, message: 'Message sent successfully' });
        } catch (error) {
            handleMessageError(error, res, next);
        }
    }
};

export default messageController;
