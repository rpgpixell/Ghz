/*
  server.js — Pixel Runner RPG Backend
  Railway + MongoDB
  Роуты: POST /auth, POST /save, GET /load
*/

const express    = require('express');
const mongoose   = require('mongoose');
const crypto     = require('crypto');
const cors       = require('cors');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS + explicit OPTIONS preflight ──
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-init-data'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // явный ответ на все preflight

app.use(express.json({ limit: '2mb' }));

// ── MongoDB (сервер стартует немедленно) ──
let dbReady = false;
if (!process.env.MONGODB_URI) {
  console.warn('WARNING: MONGODB_URI not set, running without DB');
} else {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { console.log('MongoDB connected'); dbReady = true; })
    .catch(err => console.error('MongoDB connect error:', err.message));
}

// ── Schema ──
const SaveSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, unique: true, index: true },
  username:   { type: String, default: '' },
  charType:   { type: String, default: null },
  saveData:   { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedAt:  { type: Date, default: Date.now },
});
const Save = mongoose.model('Save', SaveSchema);

// ─── DB guard middleware ──────────────────────
function requireDb(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'DB not ready' });
  next();
}

// ══════════════════════════════════════════
//  HMAC-проверка Telegram initData
// ══════════════════════════════════════════
function verifyTelegramInitData(initDataRaw) {
  try {
    const params = new URLSearchParams(initDataRaw);
    const hash   = params.get('hash');
    if (!hash) return null;

    const entries = [];
    params.forEach((val, key) => {
      if (key !== 'hash') entries.push(`${key}=${val}`);
    });
    entries.sort();
    const dataCheckString = entries.join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) return null;

    const userStr = params.get('user');
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    return null;
  }
}

// ── Middleware: проверка initData ──
function authMiddleware(req, res, next) {
  const initDataRaw = req.headers['x-init-data'];
  if (!initDataRaw) return res.status(401).json({ error: 'No init data' });

  // Dev mode
  if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'dev') {
    try {
      const params  = new URLSearchParams(initDataRaw);
      const userStr = params.get('user');
      req.tgUser = userStr ? JSON.parse(userStr) : { id: 1, username: 'dev' };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid init data' });
    }
  }

  const user = verifyTelegramInitData(initDataRaw);
  if (!user) return res.status(401).json({ error: 'Invalid signature' });

  req.tgUser = user;
  next();
}

// ══════════════════════════════════════════
//  POST /auth
// ══════════════════════════════════════════
app.post('/auth', authMiddleware, requireDb, async (req, res) => {
  try {
    const id   = String(req.tgUser.id);
    const name = req.tgUser.username || req.tgUser.first_name || '';

    let doc = await Save.findOne({ telegramId: id });
    if (!doc) {
      doc = await Save.create({ telegramId: id, username: name });
    } else if (doc.username !== name) {
      doc.username = name;
      await doc.save();
    }

    res.json({
      telegramId: doc.telegramId,
      username:   doc.username,
      charType:   doc.charType,
      hasSave:    !!doc.charType,
    });
  } catch (err) {
    console.error('/auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════
//  POST /save
// ══════════════════════════════════════════
app.post('/save', authMiddleware, requireDb, async (req, res) => {
  try {
    const id                  = String(req.tgUser.id);
    const { charType, saveData } = req.body;

    if (!charType || !saveData) {
      return res.status(400).json({ error: 'charType and saveData required' });
    }

    await Save.findOneAndUpdate(
      { telegramId: id },
      { charType, saveData, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('/save error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ══════════════════════════════════════════
//  GET /load
// ══════════════════════════════════════════
app.get('/load', authMiddleware, requireDb, async (req, res) => {
  try {
    const id  = String(req.tgUser.id);
    const doc = await Save.findOne({ telegramId: id });

    if (!doc || !doc.charType) {
      return res.json({ hasSave: false });
    }

    res.json({
      hasSave:  true,
      charType: doc.charType,
      saveData: doc.saveData,
    });
  } catch (err) {
    console.error('/load error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Health ──
app.get('/health', (req, res) => res.json({ ok: true, db: dbReady }));

app.listen(PORT, () => console.log(`Pixel Runner RPG server on port ${PORT}`));
