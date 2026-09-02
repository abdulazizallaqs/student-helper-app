import { Router } from 'express';
import favoriteController from '../controllers/favoriteController.js';
import { validateFavorite, validateId } from '../middleware/validation.js';
import { requireSession } from '../middleware/auth.js';

const router = Router();

// Get favorites
router.get('/favorite', favoriteController.getFavorites);

// Add to favorites
router.post('/add-to-favorites', validateFavorite, favoriteController.addFavorite);

// Remove from favorites. This used to have no auth check at all and did not
// verify the favorite belonged to the requester - anyone who could guess a
// favoritId could delete another user's favorite.
router.delete('/favorite/:favoritId', requireSession, favoriteController.removeFavorite);

export default router;
