import Chat from '../models/Chat.js';
import { AppError } from '../middleware/errorHandler.js';

const chatController = {
    /**
     * Get all chats for a file
     */
    getFileChats: async (req, res, next) => {
        try {
            // Comments carry student discussion plus the commenter's username.
            // Posting one already required a session (addChat below); reading
            // did not, and fileId is a sequential integer, so an anonymous
            // visitor could walk /file-chats/1,2,3... and scrape every comment
            // in the system. Everything else about files is login-gated, so
            // reading comments should be too.
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const { fileId } = req.params;
            const chats = await Chat.findByFile(fileId);
            res.json(chats);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Add a new chat message
     */
    addChat: async (req, res, next) => {
        try {
            const { fileId, chatText } = req.body;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            await Chat.create({
                fileID: fileId,
                content: chatText,
                userID: userId
            });

            res.status(200).json({ message: 'Chat added successfully' });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    }
};

export default chatController;
