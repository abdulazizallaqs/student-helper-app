import express from 'express';
import fs from 'fs';
import path from 'path';
import aiService, { AiError, describeApiKey, listAvailableModels } from '../services/aiService.js';
import File from '../models/File.js';
import { aiLimiter } from '../middleware/rateLimiters.js';
import * as storage from '../services/fileStorage.js';

const router = express.Router();

/**
 * Answer with what actually went wrong.
 *
 * Every AI route used to end `catch { res.status(500).json({error:'AI Error'}) }`,
 * so a wrong API key, an exhausted quota, a retired model ID and a firewall
 * blocking Google were all the same two words on screen and nothing in
 * between. aiService now throws AiError with a real status and a message that
 * says what to do; anything else is still treated as an internal fault and
 * kept generic.
 */
// Outside production, the underlying error text goes to the BROWSER as well
// as the log. Every AI failure so far has been diagnosed by reading the one
// line in the server console that nobody watching the page can see; putting
// it on the page is what makes the app self-explanatory while it is being
// set up. It is withheld in production because an upstream error body can
// name internal hosts and project ids.
const EXPOSE_DETAIL = process.env.NODE_ENV !== 'production';

/**
 * The JSON body for a failed AI request.
 *
 * Exported so the "detail is withheld in production" rule can be asserted
 * directly - booting the whole app in production mode to test it is not
 * possible over plain HTTP, because production (correctly) refuses non-HTTPS
 * requests.
 *
 * @param {Error} error
 * @param {boolean} exposeDetail
 * @returns {{status:number, body:object}}
 */
export function buildAiErrorBody(error, exposeDetail) {
    if (error instanceof AiError) {
        const body = { error: error.code, message: error.message };
        if (exposeDetail && error.detail) body.detail = String(error.detail).slice(0, 1200);
        return { status: error.status, body };
    }

    // Not an AiError at all - a bug in our own code on the way to the model
    // (a bad argument, a missing file). Previously indistinguishable from an
    // upstream failure.
    const body = { error: 'internal', message: 'The AI request could not be completed.' };
    if (exposeDetail) body.detail = `${error?.name || 'Error'}: ${error?.message || error}`;
    return { status: 500, body };
}

function sendAiError(res, error, where) {
    if (error instanceof AiError) {
        console.error(`[ai] ${where} failed (${error.code}): ${error.detail || error.message}`);
    } else {
        console.error(`[ai] ${where} failed:`, error);
    }
    const { status, body } = buildAiErrorBody(error, EXPOSE_DETAIL);
    return res.status(status).json(body);
}

// Middleware to check if user is logged in
const isAuthenticated = (req, res, next) => {
    if (req.session.user && req.session.user.username) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

/**
 * Locate the uploaded file on disk for a given file ID.
 * Files are stored as "<id>-<title>" inside public/uploads (see fileController.uploadFile).
 */
/**
 * Kept for anything that still wants a path. Only meaningful in disk mode -
 * in database mode the bytes have no path at all, and this returns null.
 */
export const findUploadedFilePath = (fileId) => storage.findOnDisk(fileId);

/**
 * Extract plain text from an uploaded file, for AI processing.
 * Currently only PDF text extraction is supported (matches the keyword-extraction
 * step already done on upload in fileController.uploadFile).
 */
export const extractFileText = async (fileId) => {
    // Through the storage layer, not the filesystem: on a free host the bytes
    // are in the database, and reading a path there finds nothing - which
    // would have quietly turned every summary, quiz and flashcard into "no
    // text could be read from this file".
    const stored = await storage.open(fileId);
    if (!stored) {
        const err = new Error('The contents of this file are not stored.');
        err.code = 'NOT_FOUND';
        throw err;
    }
    if (!stored.filename.toLowerCase().endsWith('.pdf')) {
        const err = new Error('AI tools currently support PDF files only.');
        err.code = 'UNSUPPORTED_TYPE';
        throw err;
    }
    const { PDFParse } = await import('pdf-parse');
    const dataBuffer = stored.buffer;
    const parser = new PDFParse({ data: dataBuffer });
    try {
        const data = await parser.getText();
        return data.text;
    } finally {
        await parser.destroy();
    }
};

router.post('/api/ai/chat', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        const { message, history } = req.body;
        if (!message || !String(message).trim()) {
            return res.status(400).json({ error: 'empty', message: 'Type a question first.' });
        }
        // Plain text, NOT markdown-rendered HTML. The page inserts this with
        // textContent (correctly - the reply is untrusted), so HTML from here
        // was displayed to the student as literal "<p>...</p>" tags.
        const response = await aiService.generateChatResponse(history || [], String(message));
        res.json({ response });
    } catch (error) {
        sendAiError(res, error, 'chat');
    }
});

router.post('/api/ai/summarize', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'empty', message: 'There is nothing to summarize.' });
        }
        // Plain text - same reason as /api/ai/chat above.
        const summary = await aiService.summarizeText(String(text));
        res.json({ summary });
    } catch (error) {
        sendAiError(res, error, 'summarize');
    }
});

/**
 * Summarize an uploaded FILE, by id.
 *
 * The card's "Sum" button used to POST the card's description to
 * /api/ai/summarize - usually one line the uploader typed, so the "summary"
 * was a paraphrase of a sentence. This reads the document itself, the same
 * way the quiz and flashcard tools already did, and only falls back to the
 * supplied text when nothing can be extracted (an image, a .docx, a zip).
 */
router.post('/api/ai/summarize/:fileId', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        const file = await File.findById(req.params.fileId);
        if (!file) return res.status(404).json({ error: 'not_found', message: 'File not found' });

        let source = '';
        try {
            source = await extractFileText(req.params.fileId);
        } catch (extractError) {
            // Not a PDF, or the blob is missing - fall back to whatever the
            // page could offer rather than failing the whole request.
            if (extractError.code !== 'UNSUPPORTED_TYPE' && extractError.code !== 'NOT_FOUND') throw extractError;
        }

        const fallback = String(req.body?.fallbackText || '').trim();
        const text = (source && source.trim()) || fallback || file.description || '';

        if (!text.trim()) {
            return res.status(400).json({
                error: 'empty',
                message: 'There is no readable text in this file to summarize.'
            });
        }

        const summary = await aiService.summarizeText(text);
        res.json({ title: file.title, summary, source: source ? 'file' : 'description' });
    } catch (error) {
        sendAiError(res, error, 'summarize-file');
    }
});

router.post('/api/ai/recommend', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        // In a real app, fetch user interests from DB
        const userInterests = "computer science, mathematics, programming";
        const recommendationsJSON = await aiService.getRecommendations(userInterests);
        let recommendations = [];
        try {
            const parsed = JSON.parse(recommendationsJSON);
            if (Array.isArray(parsed)) recommendations = parsed;
        } catch {
            // The dashboard decorates itself with these; a bad payload must
            // not turn into a 500 on the dashboard's own load.
        }
        res.json({ recommendations });
    } catch (error) {
        sendAiError(res, error, 'recommend');
    }
});

// Generate a multiple-choice quiz from an uploaded file's content.
router.post('/api/ai/quiz/:fileId', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        const file = await File.findById(req.params.fileId);
        if (!file) return res.status(404).json({ error: 'File not found' });

        const text = await extractFileText(req.params.fileId);
        const quiz = await aiService.generateQuiz(text);
        res.json({ title: file.title, quiz });
    } catch (error) {
        if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'not_found', message: 'File not found on disk' });
        if (error.code === 'UNSUPPORTED_TYPE') return res.status(400).json({ error: 'unsupported', message: error.message });
        sendAiError(res, error, 'quiz');
    }
});

// Generate flashcards from an uploaded file's content.
router.post('/api/ai/flashcards/:fileId', isAuthenticated, aiLimiter, async (req, res) => {
    try {
        const file = await File.findById(req.params.fileId);
        if (!file) return res.status(404).json({ error: 'File not found' });

        const text = await extractFileText(req.params.fileId);
        const flashcards = await aiService.generateFlashcards(text);
        res.json({ title: file.title, flashcards });
    } catch (error) {
        if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'not_found', message: 'File not found on disk' });
        if (error.code === 'UNSUPPORTED_TYPE') return res.status(400).json({ error: 'unsupported', message: error.message });
        sendAiError(res, error, 'flashcards');
    }
});

/**
 * AI health, for the admin/developer: is the key loaded, what shape is it,
 * which model is in use, and which models this key can actually call.
 * Never returns the key itself.
 */
router.get('/api/ai/health', isAuthenticated, async (req, res) => {
    const key = describeApiKey();
    const result = { keyOk: key.ok, keyKind: key.kind, keyMessage: key.message };

    if (!key.ok) return res.status(503).json(result);

    const test = await aiService.selfTest();
    result.reachable = test.ok;
    result.model = test.model;
    if (test.ok) {
        result.reply = test.reply;
    } else {
        result.error = test.error?.code;
        result.message = test.error?.message;
        try {
            result.availableModels = (await listAvailableModels()).slice(0, 25);
        } catch { /* the same failure that broke the self-test */ }
    }
    res.status(test.ok ? 200 : 502).json(result);
});

export default router;
