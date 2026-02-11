require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('../server/config/db');

const app = express();
const PORT = process.env.CORPORATE_PORT || 5002;

// Middleware - CORS supports comma-separated origins in CLIENT_URL
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Routes - all mounted under /api/corporate
app.use('/api/corporate/auth', require('./routes/auth'));
app.use('/api/corporate/catalog', require('./routes/catalog'));
app.use('/api/corporate/orders', require('./routes/orders'));
app.use('/api/corporate/quotes', require('./routes/quotes'));
app.use('/api/corporate/inquiries', require('./routes/inquiries'));

// Health check
app.get('/api/corporate/health', (req, res) => res.json({ status: 'ok', service: 'giftsity-corporate', port: PORT }));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error('[Corporate Server Error]', err.message);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err);
});

// Start
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Giftsity Corporate server running on port ${PORT}`));
});
