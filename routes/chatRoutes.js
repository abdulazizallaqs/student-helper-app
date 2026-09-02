import { Router } from 'express';
import chatController from '../controllers/chatController.js';
import { validateChatMessage } from '../middleware/validation.js';

const router = Router();

// Get chats for a file
router.get('/file-chats/:fileId', chatController.getFileChats);

// Add chat - delegate to controller
router.post('/add-chat', validateChatMessage, chatController.addChat);

export default router;