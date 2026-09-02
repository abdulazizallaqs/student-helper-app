import { Router } from 'express';
import adminController from '../controllers/adminController.js';
import { requireAdminSession } from '../middleware/auth.js';

const router = Router();

// Every route below manages user/file data across the whole system, so all of
// them require an authenticated admin session. Previously NONE of these had
// any auth check - any anonymous visitor could list every user's stats, list
// every file, or delete any user/file just by knowing the URL.
router.use('/admin/users', requireAdminSession);
router.use('/admin/files', requireAdminSession);
router.use('/admin/user-info', requireAdminSession);
router.use('/admin/delete-user', requireAdminSession);
router.use('/admin/delete-file', requireAdminSession);
router.use('/admin/stats', requireAdminSession);

// Get all users
router.get('/admin/users', adminController.getUsers);

// Get all files
router.get('/admin/files', adminController.getFiles);

// Get user info
router.get('/admin/user-info/:userId', adminController.getUserInfo);

// Delete user
router.delete('/admin/delete-user/:userId', adminController.deleteUser);

// Delete file
router.delete('/admin/delete-file/:fileId', adminController.deleteFile);

// Dashboard stats (totals + chart data)
router.get('/admin/stats', adminController.getStats);

export default router;
