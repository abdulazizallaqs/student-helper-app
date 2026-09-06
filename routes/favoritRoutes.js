import { Router } from 'express';
import favoriteController from '../controllers/favoriteController.js';
import { validateFavorite, validateId, validateFileIdParam } from '../middleware/validation.js';
import { requireSession } from '../middleware/auth.js';

const router = Router();

// Get favorites
router.get('/favorite', favoriteController.getFavorites);

// Add to favorites
router.post('/add-to-favorites', validateFavorite, favoriteController.addFavorite);

// Which files this user has favourited, so a list of cards can draw each
// bookmark filled or empty before the student touches anything.
router.get('/api/favorites/ids', requireSession, favoriteController.getFavoriteIds);

// Un-favourite by FILE id. Declared before the :favoritId route below - the
// two cannot actually collide (three path segments against two), but keeping
// the more specific pattern first is the habit that stops the day they can.
router.delete('/favorite/file/:fileId', requireSession, validateFileIdParam, favoriteController.removeFavoriteByFile);

// Remove from favorites. This used to have no auth check at all and did not
// verify the favorite belonged to the requester - anyone who could guess a
// favoritId could delete another user's favorite.
router.delete('/favorite/:favoritId', requireSession, favoriteController.removeFavorite);

export default router;
