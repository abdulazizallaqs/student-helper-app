import { Router } from 'express';
import messageController from '../controllers/messageController.js';
import { validateDirectMessage } from '../middleware/validation.js';

const router = Router();

// Get sent messages
router.get('/file-msg', messageController.getSentMessages);

// Get received messages
router.get('/msg-to-me', messageController.getReceivedMessages);

// Get all users
router.get('/msg', messageController.getUsers);

// Get conversation partners (Telegram-style chat list)
router.get('/messages/conversations', messageController.getConversations);

// Get full message thread with a specific user
router.get('/messages/thread/:userId', messageController.getThread);

// Send message - delegate to controller
router.post('/add-msg', validateDirectMessage, messageController.sendMessage);

export default router;