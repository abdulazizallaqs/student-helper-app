import { Router } from 'express';
import authController from '../controllers/authController.js';
import {
  validateRegistration,
  validatePasswordChange,
  validateAccountDeletion,
} from '../middleware/validation.js';
import { authLimiter } from '../middleware/rateLimiters.js';

const router = Router();

// Create account page
router.get('/create-account', (req, res) => {
  res.sendFile(process.cwd() + '/public/views/create-account.html');
});

// Register - delegate to controller
router.post('/create-account', validateRegistration, authController.register);

// Change your own password. Rate limited with the same limiter as login,
// since it accepts the current password and would otherwise be an
// unthrottled place to guess it.
router.post(
  '/change-password',
  authLimiter,
  validatePasswordChange,
  authController.changePassword
);

// Delete your own account, and with it (via the schema's ON DELETE CASCADE)
// every file, comment, favourite and message attached to it. Rate limited for
// the same reason - it accepts a password.
router.delete(
  '/delete-account',
  authLimiter,
  validateAccountDeletion,
  authController.deleteOwnAccount
);

export default router;
