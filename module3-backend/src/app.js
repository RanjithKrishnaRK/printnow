// src/app.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { CORS_ORIGINS, UPLOAD_DIR } = require('./config');

const shopsRouter = require('./routes/shops');
const jobsRouter = require('./routes/jobs');
const uploadsRouter = require('./routes/uploads');
const landmarksRouter = require('./routes/landmarks');
const adminRouter = require('./routes/admin');
const studentsRouter = require('./routes/students');
const convertRouter = require('./routes/convert');
const batchesRouter = require('./routes/batches');
const reviewsRouter = require('./routes/reviews');
const settingsRouter = require('./routes/settings');

const app = express();

// Baseline security headers (X-Content-Type-Options: nosniff, no X-Powered-By,
// etc.) on every response. Two defaults are deliberately overridden:
// - contentSecurityPolicy: off - this API serves JSON and uploaded
//   files, never HTML pages of its own, so a CSP meant for an HTML app
//   doesn't apply and would only risk breaking the /uploads static file
//   responses for no benefit.
// - crossOriginResourcePolicy: 'cross-origin' - uploaded files (job PDFs,
//   payment screenshots) are legitimately loaded from other origins
//   (Module 1 student app, Module 2 shop dashboard); helmet's stricter
//   default would block that.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: CORS_ORIGINS, // both Module 1 and Module 2 origins go in .env CORS_ORIGINS
  })
);

app.use(express.json());

// Serve uploaded files directly so fileUrl values returned by /api/uploads
// are immediately fetchable (e.g. http://localhost:4000/uploads/xyz.pdf)
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/shops', shopsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/landmarks', landmarksRouter);
app.use('/api/admin', adminRouter);
app.use('/api/students', studentsRouter);
app.use('/api/convert', convertRouter);
app.use('/api/batches', batchesRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/settings', settingsRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler (catches anything thrown/next(err)'d in routes)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
