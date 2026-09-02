import express from 'express';
import path from 'path';

const router = express.Router();

router.get('/views/ai-buddy.html', (req, res) => {
    // Only allow if logged in
    if (req.session.user && req.session.user.username) {
        res.sendFile(path.join(process.cwd(), 'public/views/ai-buddy.html'));
    } else {
        res.redirect('/login');
    }
});

export default router;
