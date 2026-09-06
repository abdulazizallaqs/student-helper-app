import express from 'express';
import multer from 'multer';
import fileController from '../controllers/fileController.js';
import { validateFileUpload, validateFileUpdate, validateSearch, validateCategoryName } from '../middleware/validation.js';
import fs from 'fs';
import path from 'path';
import { requireSession } from '../middleware/auth.js';
import { aiLimiter } from '../middleware/rateLimiters.js';
import { usesDatabase } from '../services/fileStorage.js';

const router = express.Router();

// Multer configuration
/**
 * Where multer puts the bytes while the request is being parsed.
 *
 * In database mode it holds them in memory instead of writing them to a disk
 * that may not exist a minute later - the upload goes straight from the
 * request into the database. The 10 MB per-file cap below is what makes that
 * safe to hold in RAM on a 512 MB free instance.
 */
const storage = usesDatabase()
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, 'public/uploads/');
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + '-' + file.originalname);
        },
    });

/**
 * What a study file is allowed to be.
 *
 * The extension matters as much as the declared type, and for a different
 * reason. `file.mimetype` is not a fact about the file - it is a header the
 * uploading client wrote, and curl will happily say `type=application/pdf`
 * about an HTML page. The old filter checked only that, and the stored name
 * kept whatever extension the uploader put in the title, so this worked:
 *
 *     curl -F 'file=@evil.html;type=application/pdf' -F 'title=notes.html'
 *
 * The file landed at public/uploads/<id>-notes.html, express.static served it
 * back as text/html from the app's own origin, and the script inside it ran
 * with the viewing user's session - able to read their profile, the user
 * directory and their messages, or (if an admin opened the link) delete
 * accounts. Verified end to end before this was changed.
 *
 * So: the declared type must be allowed AND the extension must be one that is
 * safe to hand back to a browser AND the bytes must actually be that thing.
 * All three, not any one.
 *
 * PDF ONLY, deliberately.
 * -----------------------------------------------------------------------
 * Images, Word documents and zips used to be accepted too, and every one of
 * them was a half-supported path: the AI tools (summary, quiz, flashcards)
 * refuse anything but a PDF, the search indexer reads text from PDFs alone,
 * and the viewer can display neither a .docx nor a .zip - it offers a
 * download and calls that a preview. A student who uploaded lecture notes as
 * .docx got a file that could not be read in the app, could not be
 * summarised, and could not be found by searching its contents.
 *
 * One format the whole system genuinely handles beats five it half handles.
 */
const ALLOWED_UPLOADS = new Map([
    ['application/pdf', ['.pdf']]
]);

/** The first bytes of every PDF. Not a convention - it is in the spec. */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** Every extension any allowed type may use. */
export const SAFE_UPLOAD_EXTENSIONS = new Set(
    [...ALLOWED_UPLOADS.values()].flat()
);

const fileFilter = (req, file, cb) => {
    const declared = ALLOWED_UPLOADS.get(file.mimetype);
    if (!declared) {
        return cb(new Error('Only PDF files can be uploaded.'), false);
    }

    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!declared.includes(extension)) {
        return cb(new Error(
            `A ${file.mimetype} upload must have a ${declared.join(' or ')} extension, not "${extension || 'none'}".`
        ), false);
    }

    cb(null, true);
};

/**
 * The third check: are the bytes actually a PDF?
 *
 * fileFilter above can only look at what the client SAID - `file.mimetype` is
 * a header the uploader wrote and the extension is part of a filename they
 * chose. Both are trivially faked:
 *
 *     curl -F 'file=@payload.exe;type=application/pdf' ... -F 'title=x.pdf'
 *
 * passes the filter with flying colours. Multer runs before this, so by now
 * the real bytes are here - in memory when FILE_STORAGE=database, on disk
 * otherwise - and a file that does not begin with %PDF- is not a PDF whatever
 * its name says.
 *
 * Rejected uploads are deleted, not left in public/uploads/ for the next
 * request to trip over.
 */
export async function verifyPdfSignature(req, res, next) {
    if (!req.file) return next();

    try {
        let head;
        if (req.file.buffer) {
            head = req.file.buffer.subarray(0, PDF_MAGIC.length);
        } else if (req.file.path) {
            const handle = await fs.promises.open(req.file.path, 'r');
            try {
                const target = Buffer.alloc(PDF_MAGIC.length);
                const { bytesRead } = await handle.read(target, 0, PDF_MAGIC.length, 0);
                head = target.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        } else {
            return next();
        }

        if (head.equals(PDF_MAGIC)) return next();

        if (req.file.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({
            success: false,
            error: 'notAPdf',
            message: 'That file is not a PDF. Its name says it is, but its contents are something else.'
        });
    } catch (error) {
        if (req.file?.path) await fs.promises.unlink(req.file.path).catch(() => {});
        return next(error);
    }
}

/**
 * Turn a rejected upload into an answer the page can show.
 *
 * A multer error (wrong type, too large, wrong field) is thrown from inside
 * the middleware, so without this it reached the generic error handler and
 * came back as a 500 with a stack trace - which reads as "the site is broken"
 * rather than "that file is not allowed", and leaks internals while doing it.
 */
export function handleUploadError(err, req, res, next) {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
        success: false,
        message: tooBig ? 'That file is larger than the 10 MB limit.' : err.message
    });
}

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Get categories
router.get('/categories', requireSession, fileController.getCategories);

// Create a category (used by the "+ new category" option on the upload form)
router.post('/categories', validateCategoryName, fileController.createCategory);

// Upload file
// requireSession comes BEFORE multer, deliberately.
//
// multer streams the upload to public/uploads/ as it parses the request, so
// with the session check inside the controller - where it used to be - an
// anonymous POST still wrote a 10 MB file to disk before being told 401.
// Verified: an unauthenticated curl left a file behind every time. Anyone
// could fill the disk from outside the app entirely.
router.post('/upload-note', requireSession, upload.single('file'), handleUploadError, verifyPdfSignature, validateFileUpload, fileController.uploadFile);

// Get my files
router.get('/my-files', fileController.getMyFiles);

// Get files for me (by others)
router.get('/files-for-me', fileController.getFilesForMe);

// Get file by ID (metadata)
router.get('/file/:id', requireSession, fileController.getFileById);

// Stream a file's actual bytes. The viewer uses this instead of guessing a
// /uploads/... path from the title - see fileController.serveFileContent.
router.get('/file-content/:id', fileController.serveFileContent);

// Update file
router.put('/update-file/:id', validateFileUpdate, fileController.updateFile);

// Delete file
router.delete('/file-page-myfile/:id', fileController.deleteFile);

// Search files.
// validateSearch was imported at the top of this file but never actually
// applied here, so the search term was completely unbounded - a 5,000-char
// term (or a missing one) went straight into a LIKE across three columns.
// It now enforces the same 1-100 character bound as every other text input.
// Search.
//
// This was the one file endpoint with no session check, and it had become the
// most expensive one: every unique query embeds the search text through the
// Gemini API (services/embeddingService.js) to search by meaning. Left open,
// an anonymous caller could spend the owner's embedding allowance in a loop -
// and read back every file's title, description and uploader while doing it.
// A logged-in student is the only person who has any business searching a
// library they can only otherwise browse while logged in.
router.get('/search-files', requireSession, aiLimiter, validateSearch, fileController.searchFiles);

// Get profile
router.get('/profile-data', fileController.getProfile);

export default router;
