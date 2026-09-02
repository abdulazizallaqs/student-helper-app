import { Router } from 'express';
import path from 'path';

const router = Router();

router.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'views', 'privacy-policy.html'));
});

router.get('/terms-of-service', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'views', 'terms-of-service.html'));
});

export default router;
