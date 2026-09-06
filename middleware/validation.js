import { body, param, query, validationResult } from 'express-validator';
import fs from 'fs';
import path from 'path';

// Middleware to handle validation errors
export const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Get the first error message
        const firstError = errors.array()[0];
        const errorMessage = firstError.msg;

        // Check request type.
        //
        // A GET counts as an API request here: every HTML form in this app
        // submits with POST, so a GET that fails validation is always a
        // fetch()/XHR caller (currently /search-files). Without this it fell
        // through to the "regular form submission" branch and answered 302 to
        // an HTML page, which the calling fetch() would then try to parse as
        // JSON - turning a clear "search term is too long" into a generic
        // "search failed".
        const contentType = req.headers['content-type'] || '';
        const isApiRequest = contentType.includes('application/json') || req.method === 'GET';
        const isFileUpload = contentType.includes('multipart/form-data');

        // If file was uploaded but validation failed, delete the file
        if (isFileUpload && req.file) {
            const filePath = req.file.path;
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error('Error deleting uploaded file after validation failure:', err);
                }
            });
        }

        if (isApiRequest) {
            // For API requests, return JSON
            return res.status(400).json({
                success: false,
                message: errorMessage,
                errors: errors.array().map(err => ({
                    field: err.path,
                    message: err.msg
                }))
            });
        } else if (isFileUpload) {
            // For file uploads, send HTML with script to show toast and stay on page
            return res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <link rel="stylesheet" href="../css/toast.css">
                    <script src="../js/toast.js"></script>
                </head>
                <body>
                <script>
                    if (typeof showToast === 'function') {
                        showToast('${errorMessage.replace(/'/g, "\\'")}', 'warning');
                    } else {
                        alert('${errorMessage.replace(/'/g, "\\'")}');
                    }
                    setTimeout(() => window.history.back(), 100);
                </script>
                </body>
                </html>
            `);
        } else {
            // For regular form submissions, redirect back with error message
            const referer = req.get('Referer') || '/';
            return res.redirect(`${referer}?error=${encodeURIComponent(errorMessage)}`);
        }
    }
    next();
};

// User registration validation
export const validateRegistration = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters')
        // \p{L} is "any letter in any alphabet" and \p{M} the combining marks
        // that Arabic diacritics and accented Latin letters are built from, so
        // this accepts "عبدالعزيز", "José" and "O'Brien" alike. The old
        // /^[a-zA-Z\s]+$/ rejected every Arabic name - in an app whose whole
        // interface is Arabic, which meant a student typing their real name
        // was told it was invalid and had no way to guess why.
        .matches(/^[\p{L}\p{M}\s'.-]+$/u)
        .withMessage('Name can only contain letters, spaces, apostrophes, dots and hyphens'),

    body('username')
        .trim()
        .isLength({ min: 3, max: 50 })
        .withMessage('Username must be between 3 and 50 characters')
        .matches(/^[a-zA-Z0-9_]+$/)
        .withMessage('Username can only contain letters, numbers, and underscores'),

    body('email')
        .trim()
        .isEmail()
        .withMessage('Must be a valid email address')
        .normalizeEmail(),

    body('password')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be at least 6 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),

    body('terms')
        .equals('on')
        .withMessage('You must agree to the Terms of Service and Privacy Policy'),

    handleValidationErrors
];

// Password change validation. The new password is held to exactly the same
// strength rule as registration - there is no point enforcing it at sign-up
// and then allowing "123456" as a replacement.
export const validatePasswordChange = [
    body('currentPassword')
        .notEmpty()
        .withMessage('Your current password is required'),

    body('newPassword')
        .isLength({ min: 6, max: 100 })
        .withMessage('New password must be at least 6 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('New password must contain at least one uppercase letter, one lowercase letter, and one number'),

    handleValidationErrors
];

// Account deletion validation - the account's own password must be supplied.
export const validateAccountDeletion = [
    body('password')
        .notEmpty()
        .withMessage('Your password is required to delete your account'),

    handleValidationErrors
];

// User login validation
export const validateLogin = [
    body('username')
        .trim()
        .notEmpty()
        .withMessage('Username is required')
        .isLength({ max: 50 })
        .withMessage('Username is too long'),

    body('password')
        .notEmpty()
        .withMessage('Password is required'),

    handleValidationErrors
];

// NOTE ON SANITIZATION - deliberately NO .escape() here.
//
// express-validator's .escape() MUTATES req.body, so whatever it rewrites is
// what actually gets written to the database. With it enabled, a note titled
// "Ann's & Bob's notes" was stored as "Ann&#x27;s &amp; Bob&#x27;s notes" and
// displayed that way forever (double-escaped, since the frontend escapes on
// output too). For uploads it was worse: the on-disk filename is built from
// the title, so a '#' in an entity truncated the file URL and the file became
// unopenable. Search broke as well - typed terms never matched the mangled
// stored text.
//
// The correct layering is: store exactly what the user typed, escape at the
// point of RENDERING. Every render path does that now - escapeHtml() in
// search.js / displayChat.js / admin.js and textContent everywhere else - so
// escaping here is both redundant and actively destructive.
// File upload validation
export const validateFileUpload = [
    body('title')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Title must be between 1 and 100 characters'),

    body('description')
        .trim()
        .isLength({ min: 1, max: 500 })
        .withMessage('Description must be between 1 and 500 characters'),

    // Either pick an existing category, or invent one by typing its name.
    // `category` is only required when no new name was supplied, so the
    // upload form can send one or the other.
    body('category')
        .if(body('newCategory').not().exists({ values: 'falsy' }))
        .isInt({ min: 1 })
        .withMessage('Please choose a category'),

    body('newCategory')
        .optional({ values: 'falsy' })
        .trim()
        .isLength({ min: 2, max: 60 })
        .withMessage('A new category name must be between 2 and 60 characters')
        // Letters (any alphabet, so Arabic category names work), digits,
        // spaces and a few separators. Deliberately narrow: this value ends
        // up in a dropdown every user sees.
        .matches(/^[\p{L}\p{N} .,&'()+\/-]+$/u)
        .withMessage('A category name can only contain letters, numbers, spaces and . , & \' ( ) + / -'),

    handleValidationErrors
];

// Standalone "create a category" validation (POST /categories).
export const validateCategoryName = [
    body('name')
        .trim()
        .isLength({ min: 2, max: 60 })
        .withMessage('A category name must be between 2 and 60 characters')
        .matches(/^[\p{L}\p{N} .,&'()+\/-]+$/u)
        .withMessage('A category name can only contain letters, numbers, spaces and . , & \' ( ) + / -'),

    handleValidationErrors
];

// File update validation
export const validateFileUpdate = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('File ID must be a valid number'),

    body('title2')
        .optional()
        .trim()
        .isLength({ min: 3, max: 100 })
        .withMessage('Title must be between 3 and 100 characters'),

    body('description2')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description must not exceed 500 characters'),

    body('category2')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Category must be a valid number'),

    handleValidationErrors
];

// Chat message validation
export const validateChatMessage = [
    body('chatText')
        .trim()
        .isLength({ min: 1, max: 1000 })
        .withMessage('Message must be between 1 and 1000 characters'),

    body('fileId')
        .isInt({ min: 1 })
        .withMessage('File ID must be a valid number'),

    handleValidationErrors
];

// Direct message validation
export const validateDirectMessage = [
    body('content')
        .trim()
        .isLength({ min: 1, max: 1000 })
        .withMessage('Message must be between 1 and 1000 characters'),

    body('receiver')
        .isInt({ min: 1 })
        .withMessage('Receiver ID must be a valid number'),

    handleValidationErrors
];

// ID parameter validation
export const validateId = [
    param('id')
        .isInt({ min: 1 })
        .withMessage('ID must be a valid positive number'),

    handleValidationErrors
];

// Search query validation
export const validateSearch = [
    query('query')
        .trim()
        .isLength({ min: 1, max: 100 })
        .withMessage('Search query must be between 1 and 100 characters'),

    handleValidationErrors
];

// Favorite validation
export const validateFavorite = [
    body('fileId')
        .isInt({ min: 1 })
        .withMessage('File ID must be a valid number'),

    handleValidationErrors
];
