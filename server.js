/*
  ══════════════════════════════════════════════════════
  server.js — Pixel Runner RPG Backend
  Railway + MongoDB
  Endpoints:
    POST /auth  — Telegram initData verification → JWT
    POST /save  — save game state (JWT required)
    GET  /load  — load game state (JWT required)
  ══════════════════════════════════════════════════════
*/

const express   = require('express');
const mongoose  = require('mongoose');
const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── ENV ──
const PORT        = process.env.PORT || 3000;
const MONGO_URI   = process.env.MONGODB_URL || process.env.MONGO_URL || process.env.DATABASE_URL;
const BOT_TOKEN   = process.env.BOT_TOKEN;
const JWT_SECRET  = process.env.JWT_SECRET || 'ghz_jwt_secret_change_me';

if (!MONGO_URI) { console.error('MONGODB_URL not set'); process.exit(1); }
if (!BOT_TOKEN)  console.warn('WARNING: BOT_TOKEN not set — auth will fail');

// ── MongoDB Schema ──
const saveSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true, index: true },
  username:  { type: String, default: '' },
  charId:    { type: String, default: null },
  gameState: { type: mongoose.Schema.Types.Mixed, default: null },
  updatedAt: { type: Date, default: Date.now },
});

const Save = mongoose.model('Save', saveSchema);

// ── Telegram initData verification ──
function verifyTelegramInitData(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash   = params.get('hash');
    if (!hash) return null;

    params.delete('hash');

    // Sort keys and build data-check-string
    const entries = [];
    params.forEach((val, key) => entries.push(key + '=' + val));
    entries.sort();
    const dataCheckString = entries.join('\n');

    // HMAC-SHA256: key = HMAC-SHA256("WebAppData", bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return null;

    // Check auth_date (max 24h old)
    const authDate = parseInt(params.get('auth_date') || '0');
    if (Date.now() / 1000 - authDate > 86400) return null;

    // Parse user
    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    return null;
  }
}

// ── JWT middleware ──
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ══════════════════════════════════════════════
//  POST /auth — verify Telegram initData, return JWT
// ══════════════════════════════════════════════
app.post('/auth', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'initData required' });

    let userId, username;

    // Dev mode: allow bypass with userId directly (only if no BOT_TOKEN)
    if (!BOT_TOKEN && req.body.devUserId) {
      userId   = String(req.body.devUserId);
      username = req.body.devUsername || 'dev';
    } else {
      const user = verifyTelegramInitData(initData);
      if (!user) return res.status(401).json({ error: 'Invalid initData' });
      userId   = String(user.id);
      username = user.username || user.first_name || '';
    }

    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ ok: true, token, userId, username });
  } catch (e) {
    console.error('/auth error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  POST /save — save full game state
// ══════════════════════════════════════════════
app.post('/save', requireAuth, async (req, res) => {
  try {
    const { charId, gameState } = req.body;
    if (!gameState) return res.status(400).json({ error: 'gameState required' });

    await Save.findOneAndUpdate(
      { userId: req.user.userId },
      {
        userId:    req.user.userId,
        username:  req.user.username,
        charId:    charId || null,
        gameState: gameState,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('/save error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════════
//  GET /load — load game state
// ══════════════════════════════════════════════
app.get('/load', requireAuth, async (req, res) => {
  try {
    const doc = await Save.findOne({ userId: req.user.userId });
    if (!doc || !doc.gameState) {
      return res.json({ ok: true, found: false });
    }
    res.json({
      ok:        true,
      found:     true,
      charId:    doc.charId,
      gameState: doc.gameState,
    });
  } catch (e) {
    console.error('/load error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.json({ ok: true, service: 'Pixel Runner RPG API' }));

// ── Connect MongoDB and start ──
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log('Server running on port', PORT));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
