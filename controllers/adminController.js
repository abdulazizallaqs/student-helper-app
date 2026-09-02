import User from '../models/User.js';
import File from '../models/File.js';
import { AppError } from '../middleware/errorHandler.js';
import fs from 'fs';
import path from 'path';
import db from '../models/db.js';

// Admin login/logout now go through the unified /login form and the shared
// /logout route (see controllers/authController.js and routes/loginAdminRoute.js) -
// this controller only handles the admin dashboard's data endpoints.
const adminController = {
    /**
     * Get all users with stats
     */
    getUsers: async (req, res, next) => {
        try {
            const users = await User.getUserStats();
            res.json(users);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get all files
     */
    getFiles: async (req, res, next) => {
        try {
            const files = await File.getAll();
            res.json(files);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get user info (files and comments)
     */
    getUserInfo: async (req, res, next) => {
        try {
            const { userId } = req.params;

            // Comments live in `chats` (see models/Chat.js - that is the table
            // every comment is written to and read from). This queried a
            // separate `Comments` table instead, which the app never writes
            // to: on a database that has it the admin saw an empty comment
            // list for every user, and on one that does not the whole
            // endpoint failed with a 500.
            const filesQuery = 'SELECT title FROM Files WHERE uploadedBy = ?';
            const commentsQuery = `
                SELECT c.content, c.chatDate, f.title AS fileTitle
                FROM chats c
                LEFT JOIN Files f ON c.fileID = f.id
                WHERE c.userID = ?
                ORDER BY c.chatDate DESC
            `;

            const [files] = await db.query(filesQuery, [userId]);
            const [comments] = await db.query(commentsQuery, [userId]);

            res.json({ files, comments });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Delete a user
     */
    deleteUser: async (req, res, next) => {
        try {
            const { userId } = req.params;
            const success = await User.delete(userId);

            if (success) {
                res.json({ message: 'User deleted successfully.' });
            } else {
                res.status(404).json({ message: 'User not found.' });
            }
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Delete a file
     */
    deleteFile: async (req, res, next) => {
        try {
            const { fileId } = req.params;

            // Get file info
            const getFileQuery = 'SELECT title FROM Files WHERE id = ?';
            const [results] = await db.query(getFileQuery, [fileId]);

            if (results.length === 0) {
                return res.status(404).send({ success: false, message: 'File not found.' });
            }

            // Delete the database row FIRST, then make a best effort at the
            // blob on disk.
            //
            // This used to be the other way round, and it built the on-disk
            // name as `${fileId}-${fileTitle}.pdf`. But uploads are stored as
            // `${id}-${title}` where the title ALREADY carries its extension
            // (see fileController.uploadFile), so it looked for
            // "12-notes.pdf.pdf", never found it, returned 404, and never
            // reached the DELETE - which sat inside the unlink callback. The
            // effect: admin file deletion never worked for any file, and any
            // row whose blob was missing or renamed could never be removed at
            // all. Matching by the "<id>-" prefix (the same approach
            // fileController.deleteFile uses) fixes the name, and doing the DB
            // delete first means a missing blob can no longer strand a row.
            await db.query('DELETE FROM Files WHERE id = ?', [fileId]);

            const uploadDir = path.join('public', 'uploads');
            let diskMessage = '';
            try {
                const files = await fs.promises.readdir(uploadDir);
                const fileName = files.find(f => f.startsWith(`${fileId}-`));
                if (fileName) {
                    await fs.promises.unlink(path.join(uploadDir, fileName));
                } else {
                    diskMessage = ' (no matching file on disk)';
                }
            } catch (diskErr) {
                // The record is already gone; a failure to remove the blob is
                // logged for cleanup but must not fail the request or the
                // admin is told it failed while the row is in fact deleted.
                console.error('Admin delete: could not remove file from disk:', diskErr);
                diskMessage = ' (file left on disk)';
            }

            res.status(200).send({
                success: true,
                message: `File deleted successfully.${diskMessage}`
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Dashboard stats: headline totals + chart data (files per category,
     * top 5 uploaders). Built entirely from existing tables/columns - no
     * schema migration required.
     */
    getStats: async (req, res, next) => {
        try {
            const [[{ totalUsers }]] = await db.query('SELECT COUNT(*) AS totalUsers FROM Users');
            const [[{ totalFiles }]] = await db.query('SELECT COUNT(*) AS totalFiles FROM Files');
            const [[{ totalFavorites }]] = await db.query('SELECT COUNT(*) AS totalFavorites FROM Favorit');
            // Same table mix-up as getUserInfo above: comments are rows in
            // `chats`, so this counter always read 0 (or blew up).
            const [[{ totalComments }]] = await db.query('SELECT COUNT(*) AS totalComments FROM chats');

            const [filesByCategory] = await db.query(`
                SELECT Categories.name AS category, COUNT(Files.id) AS fileCount
                FROM Categories
                LEFT JOIN Files ON Files.categoryID = Categories.id
                GROUP BY Categories.id, Categories.name
                ORDER BY fileCount DESC
            `);

            const userStats = await User.getUserStats();
            const topUploaders = [...userStats]
                .sort((a, b) => b.fileCount - a.fileCount)
                .slice(0, 5)
                .filter(u => u.fileCount > 0)
                .map(u => ({ username: u.username, fileCount: u.fileCount }));

            res.json({
                totals: {
                    users: totalUsers,
                    files: totalFiles,
                    favorites: totalFavorites,
                    comments: totalComments
                },
                filesByCategory,
                topUploaders
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    }
};

export default adminController;
