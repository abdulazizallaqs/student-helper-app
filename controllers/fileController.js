import File from '../models/File.js';
import User from '../models/User.js';
import { indexFileInBackground } from '../services/searchIndexer.js';
import * as storage from '../services/fileStorage.js';
import { AppError } from '../middleware/errorHandler.js';
import fs from 'fs';
import path from 'path';

// Uploaded bytes are reached through services/fileStorage.js now, not through
// paths and readdir - it is the one place that knows whether they live in
// public/uploads or in the database.

/**
 * Strip anything from a user-supplied title that must not end up in a real
 * filename or in a URL path segment.
 *
 * The stored name is `<id>-<title>`, built straight from what the uploader
 * typed. A title containing `/` or `\` wrote the upload into a different
 * directory (or failed outright); a `#` or `?` truncated the URL the viewer
 * requested, so the file existed but could never be opened.
 */
function safeFileName(name) {
    return String(name)
        .replace(/[\\/:*?"<>|#%&{}$!'`@+=]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

const fileController = {
    /**
     * Get all categories
     */
    getCategories: async (req, res, next) => {
        try {
            const categories = await File.getCategories();
            res.json(categories);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Create a category (or return the existing one with that name).
     * Lets a student file a note under a subject nobody has uploaded for yet,
     * instead of being limited to whatever rows happen to be in Categories.
     */
    createCategory: async (req, res, next) => {
        try {
            if (!req.session?.user?.id && !req.session?.admin?.id) {
                return res.status(401).json({ success: false, message: 'Please log in first.' });
            }
            const category = await File.findOrCreateCategory(req.body.name);
            return res.status(category.created ? 201 : 200).json({ success: true, category });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Upload a new file
     */
    uploadFile: async (req, res, next) => {
        try {
            const { title, description, newCategory } = req.body;
            let { category } = req.body;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).send('Unauthorized: Please log in to upload files.');
            }

            if (!req.file) {
                return res.status(400).send('No file uploaded.');
            }

            // "Add a new category" on the upload form: resolve the typed name
            // to a real Categories row (reusing an existing one if the name
            // already exists) before the file record references it.
            if (newCategory && String(newCategory).trim()) {
                const resolved = await File.findOrCreateCategory(newCategory);
                category = resolved.id;
            }

            // Append extension to title for DB storage
            const ext = path.extname(req.file.originalname);
            // Ensure title doesn't already have the extension to avoid duplication
            const titleWithExt = title.endsWith(ext) ? title : (title + ext);

            // Create file record
            const fileData = await File.create({
                categoryID: category,
                title: titleWithExt,
                description,
                uploadedBy: userId
            });

            // The stored name is `<id>-<safe title>`; the id prefix is what
            // every lookup keys on, because the title can be edited later.
            const storedName = `${fileData.id}-${safeFileName(titleWithExt)}`;

            try {
                // One call, whichever mode is configured: rename into
                // public/uploads on a real disk, or write the bytes into the
                // database on a host whose disk does not survive a restart.
                // See services/fileStorage.js.
                await storage.save({
                    fileId: fileData.id,
                    storedName,
                    buffer: req.file.buffer,
                    tempPath: req.file.path
                });
                console.log(`File uploaded (${storage.storageMode()}):`, storedName);

                // --- AI INTEGRATION START ---
                try {
                    const aiService = (await import('../services/aiService.js')).default;
                    const { PDFParse } = await import('pdf-parse');

                    if (req.file.mimetype === 'application/pdf') {
                        // Read it back through the storage layer rather than
                        // from a path - in database mode there is no path.
                        const stored = await storage.open(fileData.id);
                        const dataBuffer = stored ? stored.buffer : req.file.buffer;
                        const parser = new PDFParse({ data: dataBuffer });
                        const data = await parser.getText();
                        await parser.destroy();

                        const keywords = await aiService.generateKeywords(data.text);
                        console.log('Generated Keywords:', keywords);

                        if (keywords) {
                            const newDescription = description + " | Keywords: " + keywords;
                            // File.update is owner-scoped (it takes the owner
                            // id and only touches rows belonging to them).
                            // This call omitted it, so every upload threw
                            // "missing owner id" here and the AI keywords
                            // were silently never saved - the failure was
                            // swallowed by the catch below and only ever
                            // appeared in the server log.
                            await File.update(fileData.id, { description: newDescription }, userId);
                        }
                    }
                } catch (aiError) {
                    console.error('AI Processing Error:', aiError);
                }
                // --- AI INTEGRATION END ---

                // Redirect with a marker so the page can confirm the upload.
                // Previously it returned to a blank form with no feedback at
                // all, which is why "did my file actually upload?" was
                // impossible to answer from the UI.
                res.redirect(`/views/add-file.html?uploaded=${encodeURIComponent(fileData.id)}`);

                // Build the file's semantic-search vector AFTER the response
                // has gone out. Uploading already waits on one AI call (the
                // keywords); making it wait on a second, for a feature the
                // uploader will not notice either way, would be the wrong
                // trade. The row is read fresh inside, so it picks up the
                // keywords that were just appended to the description.
                indexFileInBackground(fileData.id);

            } catch (storeErr) {
                console.error('Error storing the uploaded file:', storeErr);
                return res.status(500).send('File upload error.');
            }
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Stream an uploaded file's actual bytes to a logged-in viewer.
     *
     * Display.html used to build the URL itself as
     * `/uploads/<id>-<title><guessed extension>` from the JSON returned by
     * `/file/:id`. That guess broke in several ordinary cases: a title with a
     * space, `#`, `&` or a slash in it; a title edited after upload (the blob
     * on disk keeps its original name); and files stored before the current
     * naming convention. When the guess was wrong the browser fetched a
     * missing path, the viewer stayed blank, and nothing said whether the
     * upload had failed or the URL was simply wrong.
     *
     * Resolving the blob server-side by its `<id>-` prefix removes the guess
     * entirely, and the two distinct 404s below finally tell those two cases
     * apart.
     */
    serveFileContent: async (req, res, next) => {
        try {
            if (!req.session?.user?.id && !req.session?.admin?.id) {
                return res.status(401).json({ error: 'Please log in to open this file.' });
            }

            const { id } = req.params;
            const file = await File.findById(id);
            if (!file) {
                return res.status(404).json({
                    error: 'notFound',
                    message: 'There is no file with this id.'
                });
            }

            const stored = await storage.open(id);
            if (!stored) {
                return res.status(404).json({
                    error: 'missingOnDisk',
                    message: storage.usesDatabase()
                        ? 'This file is listed in the database, but its contents were never stored. Ask the uploader to upload it again.'
                        : 'This file is listed in the database, but its upload is not on the server. It was most likely never stored, or it was removed from public/uploads.'
                });
            }

            // The type comes from an allowlist keyed on the extension, never
            // from anything the uploader sent - an HTML file served as
            // text/html from this origin would run as a page on it.
            res.type(stored.mimeType);
            // `inline` so PDFs and images render in the viewer instead of
            // downloading. The filename is quoted and stripped of quotes so a
            // title cannot break out of the header.
            res.setHeader(
                'Content-Disposition',
                `inline; filename="${stored.filename.replace(/"/g, '')}"`
            );
            res.setHeader('Content-Length', stored.byteSize);
            return res.send(stored.buffer);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get files uploaded by the logged-in user
     */
    getMyFiles: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const files = await File.findByUser(userId);
            res.json(files);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get files uploaded by other users
     */
    getFilesForMe: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const files = await File.findByOthers(userId);
            res.json(files);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get file by ID
     */
    getFileById: async (req, res, next) => {
        try {
            const { id } = req.params;
            const file = await File.findById(id);

            if (!file) {
                return res.status(404).json({ error: 'File not found' });
            }

            res.json(file);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Update file details
     */
    updateFile: async (req, res, next) => {
        try {
            const { id } = req.params;
            const { title2, description2, category2 } = req.body;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const updates = {};
            if (title2) updates.title = title2;
            if (description2) updates.description = description2;
            if (category2) updates.categoryID = category2;

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ success: false, message: 'Nothing to update.' });
            }

            // userId scopes the UPDATE to files this user actually owns.
            const success = await File.update(id, updates, userId);

            if (success) {
                res.status(200).json({ success: true, message: 'File updated successfully' });
                // The title or description just changed, so the stored vector
                // now describes text that no longer exists. Re-embed it.
                if (updates.title || updates.description || updates.categoryID) {
                    indexFileInBackground(Number(id));
                }
            } else {
                // Covers both "no such file" and "not your file" - deliberately
                // the same answer, so this can't be used to probe which ids exist.
                res.status(404).json({ success: false, message: 'File not found' });
            }
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Delete a file
     */
    /**
     * Delete a file
     */
    deleteFile: async (req, res, next) => {
        try {
            const { id } = req.params;
            const userId = req.session.user?.id;

            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const result = await File.delete(id, userId);

            // Either the file doesn't exist or it belongs to someone else.
            // Same 404 for both, so this can't be used to probe which ids
            // exist. Previously this path threw and surfaced as a 500 with an
            // internal message ("Error deleting file: File not found or
            // unauthorized") attached to the response.
            if (!result) {
                return res.status(404).json({ success: false, message: 'File not found.' });
            }

            // Remove the stored bytes too. This used to be forty lines of
            // callback-style fs.readdir/fs.unlink that only understood a real
            // disk; it is one call now, and it does the right thing whether
            // the bytes are in public/uploads or in the database.
            //
            // A failure here is logged, not surfaced: the database row is
            // already gone, so the delete succeeded from the user's point of
            // view, and turning a tidy-up problem into an error on screen
            // would just be confusing.
            const removed = await storage.remove(id);
            return res.status(200).send({
                success: true,
                message: removed ? 'File deleted successfully.' : 'File deleted (its contents were already missing).'
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Search files.
     *
     * Returns the same JSON array it always did, best match first. Each row
     * additionally carries `_score` (how well it matched) and `_fuzzy` (true
     * when the row was only reached by typo-tolerant matching) so the results
     * page can tell the user it is showing approximations rather than exact
     * hits. Ranking lives in services/searchService.js - see the notes there
     * for why it is done in JS rather than in SQL.
     */
    searchFiles: async (req, res, next) => {
        try {
            const { query } = req.query;
            const files = await File.search(query);
            res.json(files);
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    },

    /**
     * Get user profile data
     */
    getProfile: async (req, res, next) => {
        try {
            const userId = req.session.user?.id;
            if (!userId) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            // This used to return ONLY { files }, while profile.html expected
            // {userId, name, email, username} - so even once the page was
            // pointed at the right URL, every field would still have come back
            // undefined. Returns the identity fields alongside the files now.
            //
            // The password hash is deliberately NOT included: profile.html has
            // a password input it was trying to prefill, which would have put
            // the user's bcrypt hash into the DOM and over the wire.
            const [user, files] = await Promise.all([
                User.findById(userId),
                File.findByUser(userId)
            ]);

            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({
                userId: user.userId,
                name: user.name,
                username: user.username,
                email: user.email,
                files
            });
        } catch (error) {
            next(new AppError(error.message, 500));
        }
    }
};

export default fileController;
