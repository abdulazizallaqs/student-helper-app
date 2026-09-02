// Custom error class for application errors
export class AppError extends Error {
    constructor(message, statusCode, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
        Error.captureStackTrace(this, this.constructor);
    }
}

// Global error handling middleware
export const errorHandler = (err, req, res, next) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    // Log error for debugging
    console.error('ERROR 💥:', err);

    // Development error response (detailed)
    if (process.env.NODE_ENV === 'development') {
        return res.status(err.statusCode).json({
            status: err.status,
            error: err,
            message: err.message,
            stack: err.stack
        });
    }

    // 5xx responses NEVER carry err.message to the client.
    //
    // Controllers throughout this app do `next(new AppError(error.message, 500))`,
    // and the models build that message by interpolating the raw driver error
    // (e.g. `Error creating chat: ${error.message}`). Since AppError defaults
    // isOperational to true, those went straight out to the client: a request
    // with a bad foreign key returned the database name, table name and
    // constraint name in the JSON body. A 5xx is by definition not something
    // the user can act on, so it gets a generic message - the real error is
    // still logged above for the developer.
    if (err.statusCode >= 500) {
        return res.status(err.statusCode).json({
            status: 'error',
            message: 'Something went wrong on our side. Please try again.'
        });
    }

    // 4xx operational errors are deliberate, safe, user-facing messages.
    if (err.isOperational) {
        return res.status(err.statusCode).json({
            status: err.status,
            message: err.message
        });
    }

    // Programming or unknown error: don't leak error details
    return res.status(500).json({
        status: 'error',
        message: 'Something went wrong!'
    });
};

// Async error wrapper to catch errors in async route handlers
export const catchAsync = (fn) => {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
};

// 404 handler for undefined routes
export const notFoundHandler = (req, res, next) => {
    const err = new AppError(`Can't find ${req.originalUrl} on this server!`, 404);
    next(err);
};
