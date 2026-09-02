import Favorite from '../models/Favorite.js';
import { AppError } from '../middleware/errorHandler.js';

const favoriteController = {
    /**
     * Get user's favorites
     */
    getFavorites: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const favorites = await Favorite.findByUser(userId);
            res.status(200).send(favorites);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Add to favorites
     */
    addFavorite: async (req, res, next) => {
        try {
            const { fileId } = req.body;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ success: false, message: 'Unauthorized.' });
            }

            const result = await Favorite.add(userId, fileId);
            res.status(200).json({
                success: true,
                alreadyExists: !!result.alreadyExists,
                message: result.alreadyExists ? 'File is already in your favorites.' : 'Added to favorites.'
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Remove from favorites
     */
    removeFavorite: async (req, res, next) => {
        try {
            const { favoritId } = req.params;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const success = await Favorite.remove(favoritId, userId);

            if (success) {
                res.status(200).json({ success: true, message: 'File removed from favorites.' });
            } else {
                res.status(404).json({ success: false, message: 'Favorite not found.' });
            }
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    }
};

export default favoriteController;
