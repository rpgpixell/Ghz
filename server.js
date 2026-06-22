/*
  ══════════════════════════════════════════════════════
  server.js — Полный бэкенд для Pixel Runner Telegram Mini App
  ══════════════════════════════════════════════════════
*/

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──

// CORS настройки
app.use(cors({
  origin: ['https://ghz-production.up.railway.app', 'http://localhost:3000', '*'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data', 'Authorization']
}));

// ── ЯВНАЯ ОБРАБОТКА OPTIONS (ВАЖНО ДЛЯ TELEGRAM) ──
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
});

// ── Глобальный middleware для CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Если OPTIONS — сразу отвечаем
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── MongoDB Connection ──
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pixel_runner';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ── Models ──

const UserSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  username: { type: String, default: '' },
  firstName: { type: String, default: '' },
  lastName: { type: String, default: '' },
  photoUrl: { type: String, default: '' },
  authDate: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
  lastSaveAt: { type: Date, default: Date.now }
});

const UserStatsSchema = new mongoose.Schema({
  telegramId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  level: { type: Number, default: 1 },
  xp: { type: Number, default: 0 },
  xpNeeded: { type: Number, default: 100 },
  floor: { type: Number, default: 1 },
  maxFloor: { type: Number, default: 1 },
  killCount: { type: Number, default: 0 },
  
  gold: { type: Number, default: 0 },
  pixr: { type: Number, default: 0 },
  gram: { type: Number, default: 0 },
  
  stats: {
    atk: { type: Number, default: 10 },
    def: { type: Number, default: 5 },
    spd: { type: Number, default: 3 },
    hp: { type: Number, default: 100 },
    crit: { type: Number, default: 5 },
    dodge: { type: Number, default: 3 },
    atkSpd: { type: Number, default: 1.0 }
  },
  
  hp: { type: Number, default: 100 },
  maxHp: { type: Number, default: 100 },
  
  baseStats: {
    atk: { type: Number, default: 10 },
    def: { type: Number, default: 5 },
    spd: { type: Number, default: 3 },
    hp: { type: Number, default: 100 },
    crit: { type: Number, default: 5 },
    dodge: { type: Number, default: 3 },
    atkSpd: { type: Number, default: 1.0 }
  },
  
  upg: {
    atk: { type: Number, default: 0 },
    def: { type: Number, default: 0 },
    hp: { type: Number, default: 0 },
    spd: { type: Number, default: 0 },
    crit: { type: Number, default: 0 },
    dodge: { type: Number, default: 0 },
    atkSpd: { type: Number, default: 0 }
  },
  
  character: {
    type: String,
    enum: ['fire', 'light', 'water'],
    default: 'fire'
  },
  
  inventory: { type: Array, default: [] },
  
  equipped: {
    weapon: { type: Object, default: null },
    body: { type: Object, default: null },
    legs: { type: Object, default: null },
    gloves: { type: Object, default: null },
    boots: { type: Object, default: null },
    helmet: { type: Object, default: null },
    ring: { type: Object, default: null },
    belt: { type: Object, default: null }
  },
  
  skills: { type: Object, default: {} },
  
  potions: { type: Number, default: 0 },
  potionLv: { type: Number, default: 0 },
  potionThreshold: { type: Number, default: 30 },
  
  bp: {
    active: { type: Boolean, default: false },
    claimed: { type: Array, default: [] }
  },
  
  prem: {
    tier: { type: String, default: null },
    expiresAt: { type: Number, default: 0 }
  },
  
  invFilter: { type: String, default: 'all' },
  invIdCounter: { type: Number, default: 0 },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const User = mongoose.model('User', UserSchema);
const UserStats = mongoose.model('UserStats', UserStatsSchema);

// ── Telegram Auth Helper ──
function verifyTelegramAuth(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    
    const sortedParams = Array.from(params.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN || '')
      .digest();
    
    const computedHash = crypto
      .createHmac('sha256', secretKey)
      .update(sortedParams)
      .digest('hex');
    
    return computedHash === hash;
  } catch (error) {
    console.error('Auth verification error:', error);
    return false;
  }
}

function parseTelegramUser(initData) {
  const params = new URLSearchParams(initData);
  const userStr = params.get('user');
  if (!userStr) return null;
  
  try {
    return JSON.parse(decodeURIComponent(userStr));
  } catch {
    return null;
  }
}

// ── Middleware Auth ──
async function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || req.body.initData;
  
  if (!initData) {
    return res.status(401).json({ error: 'No init data provided' });
  }
  
  if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true') {
    const tgUser = parseTelegramUser(initData);
    if (tgUser) {
      req.user = tgUser;
      req.telegramId = String(tgUser.id);
      return next();
    }
  }
  
  const isValid = verifyTelegramAuth(initData);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid authentication' });
  }
  
  const tgUser = parseTelegramUser(initData);
  if (!tgUser) {
    return res.status(401).json({ error: 'Invalid user data' });
  }
  
  req.user = tgUser;
  req.telegramId = String(tgUser.id);
  next();
}

// ── Routes ──

// Health check
app.get('/health', (req, res) => {
  return res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ── 1. AUTH ──
app.post('/api/auth/init', authMiddleware, async (req, res) => {
  try {
    const { telegramId, user } = req;
    
    let userDoc = await User.findOne({ telegramId });
    let statsDoc = await UserStats.findOne({ telegramId });
    
    if (!userDoc) {
      userDoc = new User({
        telegramId,
        username: user.username || '',
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        photoUrl: user.photo_url || ''
      });
      await userDoc.save();
    }
    
    if (!statsDoc) {
      statsDoc = new UserStats({ telegramId });
      await statsDoc.save();
    }
    
    return res.json({
      success: true,
      user: {
        id: userDoc.telegramId,
        username: userDoc.username,
        firstName: userDoc.firstName,
        photoUrl: userDoc.photoUrl
      },
      stats: statsDoc
    });
    
  } catch (error) {
    console.error('Init error:', error);
    return res.status(500).json({ error: 'Failed to initialize user' });
  }
});

// ── 2. SAVE ──
app.post('/api/save', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    const data = req.body;
    
    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }
    
    let stats = await UserStats.findOne({ telegramId });
    if (!stats) {
      stats = new UserStats({ telegramId });
    }
    
    const fieldMapping = {
      level: 'level',
      xp: 'xp',
      xpNeeded: 'xpNeeded',
      floor: 'floor',
      maxFloor: 'maxFloor',
      killCount: 'killCount',
      gold: 'gold',
      pixr: 'pixr',
      gram: 'gram',
      hp: 'hp',
      maxHp: 'maxHp',
      potions: 'potions',
      potionLv: 'potionLv',
      potionThreshold: 'potionThreshold',
      invFilter: 'invFilter',
      invIdCounter: 'invIdCounter',
      character: 'character'
    };
    
    Object.keys(fieldMapping).forEach(key => {
      if (data[key] !== undefined && data[key] !== null) {
        stats[fieldMapping[key]] = data[key];
      }
    });
    
    if (data.stats) {
      Object.keys(data.stats).forEach(key => {
        if (data.stats[key] !== undefined) {
          stats.stats[key] = data.stats[key];
        }
      });
    }
    
    if (data.baseStats) {
      Object.keys(data.baseStats).forEach(key => {
        if (data.baseStats[key] !== undefined) {
          stats.baseStats[key] = data.baseStats[key];
        }
      });
    }
    
    if (data.upg) {
      Object.keys(data.upg).forEach(key => {
        if (data.upg[key] !== undefined) {
          stats.upg[key] = data.upg[key];
        }
      });
    }
    
    if (data.inventory && Array.isArray(data.inventory)) {
      stats.inventory = data.inventory;
    }
    
    if (data.equipped) {
      Object.keys(data.equipped).forEach(slot => {
        stats.equipped[slot] = data.equipped[slot] || null;
      });
    }
    
    if (data.skills) {
      stats.skills = data.skills;
    }
    
    if (data.bp) {
      stats.bp.active = data.bp.active || false;
      if (data.bp.claimed && Array.isArray(data.bp.claimed)) {
        stats.bp.claimed = data.bp.claimed;
      }
    }
    
    if (data.prem) {
      stats.prem.tier = data.prem.tier || null;
      stats.prem.expiresAt = data.prem.expiresAt || 0;
    }
    
    stats.updatedAt = new Date();
    await stats.save();
    
    await User.findOneAndUpdate(
      { telegramId },
      { lastSaveAt: new Date() }
    );
    
    return res.json({
      success: true,
      savedAt: stats.updatedAt,
      message: 'Progress saved successfully'
    });
    
  } catch (error) {
    console.error('Save error:', error);
    return res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ── 3. LOAD ──
app.get('/api/load', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    
    const stats = await UserStats.findOne({ telegramId });
    if (!stats) {
      return res.status(404).json({ error: 'User stats not found' });
    }
    
    return res.json({
      success: true,
      stats: stats
    });
    
  } catch (error) {
    console.error('Load error:', error);
    return res.status(500).json({ error: 'Failed to load progress' });
  }
});

// ── 4. LEADERBOARD ──
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const leaderboard = await UserStats.aggregate([
      {
        $addFields: {
          cp: {
            $add: [
              { $multiply: ['$stats.atk', 4] },
              { $multiply: ['$stats.def', 3] },
              { $multiply: ['$stats.hp', 0.5] },
              { $multiply: ['$stats.spd', 6] },
              { $multiply: ['$stats.crit', 8] },
              { $multiply: ['$stats.dodge', 8] },
              { $multiply: [{ $subtract: [{ $ifNull: ['$stats.atkSpd', 1] }, 1] }, 200] },
              { $multiply: ['$level', 20] }
            ]
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: 'telegramId',
          foreignField: 'telegramId',
          as: 'user'
        }
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true
        }
      },
      {
        $project: {
          telegramId: 1,
          level: 1,
          floor: 1,
          killCount: 1,
          cp: 1,
          character: 1,
          username: { $ifNull: ['$user.username', '$user.firstName', 'Unknown'] },
          photoUrl: '$user.photoUrl'
        }
      },
      { $sort: { cp: -1 } },
      { $skip: offset },
      { $limit: limit }
    ]);
    
    const total = await UserStats.countDocuments();
    
    return res.json({
      success: true,
      leaderboard,
      total,
      offset,
      limit
    });
    
  } catch (error) {
    console.error('Leaderboard error:', error);
    return res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// ── 5. GET USER STATS ──
app.get('/api/user/:telegramId', async (req, res) => {
  try {
    const { telegramId } = req.params;
    
    const stats = await UserStats.findOne({ telegramId });
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = await User.findOne({ telegramId });
    
    return res.json({
      success: true,
      user: {
        id: stats.telegramId,
        username: user?.username || user?.firstName || 'Unknown',
        photoUrl: user?.photoUrl || ''
      },
      stats: {
        level: stats.level,
        floor: stats.floor,
        killCount: stats.killCount,
        gold: stats.gold,
        pixr: stats.pixr,
        gram: stats.gram,
        character: stats.character
      }
    });
    
  } catch (error) {
    console.error('Get user error:', error);
    return res.status(500).json({ error: 'Failed to get user stats' });
  }
});

// ── 6. RESET ──
app.post('/api/reset', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    
    await UserStats.findOneAndDelete({ telegramId });
    const newStats = new UserStats({ telegramId });
    await newStats.save();
    
    return res.json({
      success: true,
      message: 'Progress reset successfully',
      stats: newStats
    });
    
  } catch (error) {
    console.error('Reset error:', error);
    return res.status(500).json({ error: 'Failed to reset progress' });
  }
});

// ── 7. UPDATE CHARACTER ──
app.post('/api/character', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    const { character } = req.body;
    
    if (!['fire', 'light', 'water'].includes(character)) {
      return res.status(400).json({ error: 'Invalid character' });
    }
    
    const stats = await UserStats.findOneAndUpdate(
      { telegramId },
      { character, updatedAt: new Date() },
      { new: true }
    );
    
    if (!stats) {
      return res.status(404).json({ error: 'User stats not found' });
    }
    
    return res.json({
      success: true,
      stats
    });
    
  } catch (error) {
    console.error('Character update error:', error);
    return res.status(500).json({ error: 'Failed to update character' });
  }
});

// ── 8. BATTLE PASS ──
app.post('/api/bp/buy', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    
    const stats = await UserStats.findOne({ telegramId });
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (stats.bp.active) {
      return res.status(400).json({ error: 'Battle Pass already active' });
    }
    
    if (stats.gram < 10) {
      return res.status(400).json({ error: 'Not enough GRAM' });
    }
    
    stats.gram -= 10;
    stats.bp.active = true;
    await stats.save();
    
    return res.json({
      success: true,
      message: 'Battle Pass activated',
      stats
    });
    
  } catch (error) {
    console.error('BP buy error:', error);
    return res.status(500).json({ error: 'Failed to buy Battle Pass' });
  }
});

// ── 9. PREMIUM ──
app.post('/api/premium/buy', authMiddleware, async (req, res) => {
  try {
    const { telegramId } = req;
    const { tier } = req.body;
    
    const TIERS = {
      gold: { cost: 10, days: 7, name: 'GOLD' },
      plat: { cost: 50, days: 7, name: 'PLATINUM' },
      ultra: { cost: 300, days: 30, name: 'ULTRA' }
    };
    
    if (!TIERS[tier]) {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    
    const stats = await UserStats.findOne({ telegramId });
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    if (stats.gram < TIERS[tier].cost) {
      return res.status(400).json({ error: 'Not enough GRAM' });
    }
    
    stats.gram -= TIERS[tier].cost;
    const now = Date.now();
    const currentExpiry = stats.prem.expiresAt || 0;
    const baseExpiry = currentExpiry > now ? currentExpiry : now;
    stats.prem.tier = tier;
    stats.prem.expiresAt = baseExpiry + TIERS[tier].days * 86400000;
    await stats.save();
    
    return res.json({
      success: true,
      message: `${TIERS[tier].name} Premium activated`,
      stats
    });
    
  } catch (error) {
    console.error('Premium buy error:', error);
    return res.status(500).json({ error: 'Failed to buy Premium' });
  }
});

// ── Error handling ──
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  return res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// ── Start server ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 API URL: http://0.0.0.0:${PORT}`);
  console.log(`🔗 Health check: http://0.0.0.0:${PORT}/health`);
});