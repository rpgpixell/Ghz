/*
  ══════════════════════════════════════════════════════
  server.js — Backend для Pixel Runner RPG
  Express + MongoDB (Mongoose) + Telegram WebApp auth
  
  Версия: 2.0.0
  ══════════════════════════════════════════════════════
*/

require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// ═══════════════════════════════
//  КОНСТАНТЫ
// ═══════════════════════════════
const API_VERSION = 'v1';
const MAX_REQUEST_SIZE = 5 * 1024 * 1024; // 5MB
const SAVE_RATE_LIMIT = 30; // 30 сохранений в минуту
const GENERAL_RATE_LIMIT = 100; // 100 запросов в минуту
const LEADERBOARD_LIMIT = 50;
const INACTIVE_DAYS = 30;

// Лимиты для валидации игровых данных
const GAME_LIMITS = {
  maxLevel: 9999,
  maxGold: 999999999,
  maxPixr: 999999999,
  maxGram: 999999999,
  maxFloor: 9999,
  maxHp: 999999,
  maxInventory: 500,
  minHp: 0,
  minLevel: 1
};

// ═══════════════════════════════
//  1. БЕЗОПАСНОСТЬ
// ═══════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false, // Отключаем CSP для Telegram WebApp
  crossOriginEmbedderPolicy: false
}));

// ═══════════════════════════════
//  2. CORS
// ═══════════════════════════════
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://your-game.railway.app',
    'https://web.telegram.org',
    'https://telegram.org'
  ];
  
  const origin = req.headers.origin;
  
  // В разработке разрешаем все origins
  if (process.env.NODE_ENV === 'development') {
    res.header('Access-Control-Allow-Origin', origin || '*');
  } else {
    // В продакшене проверяем origin
    if (allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    } else if (origin && origin.startsWith('https://web.telegram.org')) {
      res.header('Access-Control-Allow-Origin', origin);
    } else {
      res.header('Access-Control-Allow-Origin', 'https://web.telegram.org');
    }
  }
  
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Max-Age', '86400'); // 24 часа
  res.header('Vary', 'Origin');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ═══════════════════════════════
//  3. СЖАТИЕ
// ═══════════════════════════════
app.use(compression({
  threshold: 1024, // Сжимаем ответы больше 1KB
  level: 6         // Уровень сжатия (1-9)
}));

// ═══════════════════════════════
//  4. RATE LIMITING
// ═══════════════════════════════

// Общий лимит для всех запросов
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: GENERAL_RATE_LIMIT,
  message: { ok: false, error: 'rate_limit', message: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Приоритет: Telegram ID > IP
    try {
      const body = req.body;
      if (body && body.initData) {
        const params = new URLSearchParams(body.initData);
        const user = JSON.parse(params.get('user') || '{}');
        return user.id || req.ip;
      }
    } catch (e) {}
    return req.ip;
  }
});

// Строгий лимит для сохранений
const saveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: SAVE_RATE_LIMIT,
  message: { ok: false, error: 'too_many_saves', message: 'Too many save requests' },
  keyGenerator: (req) => {
    try {
      const body = req.body;
      if (body && body.initData) {
        const params = new URLSearchParams(body.initData);
        const user = JSON.parse(params.get('user') || '{}');
        return user.id || req.ip;
      }
    } catch (e) {}
    return req.ip;
  }
});

app.use(generalLimiter);

// ═══════════════════════════════
//  5. ЛОГИРОВАНИЕ ЗАПРОСОВ
// ═══════════════════════════════
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Логируем ошибки и медленные запросы
    if (res.statusCode >= 400 || duration > 1000) {
      console.warn(`⚠️ ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
    }
  });
  
  next();
});

// ═══════════════════════════════
//  6. ЗАЩИТА ОТ БОЛЬШИХ ЗАПРОСОВ
// ═══════════════════════════════
app.use((req, res, next) => {
  if (req.method === 'GET') {
    return next();
  }
  
  let size = 0;
  
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_REQUEST_SIZE) {
      console.warn(`⚠️ Request too large from ${req.ip}: ${size} bytes`);
      res.status(413).json({ 
        ok: false, 
        error: 'payload_too_large',
        message: 'Request body too large'
      });
      req.destroy();
    }
  });
  
  next();
});

// ═══════════════════════════════
//  7. БЕЗОПАСНЫЙ ПАРСИНГ JSON
// ═══════════════════════════════
app.use((req, res, next) => {
  if (req.method === 'GET') {
    return next();
  }

  let body = '';
  
  req.on('data', chunk => {
    body += chunk;
  });
  
  req.on('end', () => {
    try {
      req.body = body ? JSON.parse(body) : {};
      next();
    } catch (err) {
      console.warn('⚠️ Invalid JSON from', req.ip);
      res.status(400).json({ 
        ok: false, 
        error: 'invalid_json',
        message: 'Invalid JSON format'
      });
    }
  });
  
  req.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.message?.includes('aborted')) {
      return;
    }
    next(err);
  });
});

// ═══════════════════════════════
//  8. MongoDB
// ═══════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI не задан в переменных окружения');
  process.exit(1);
}

mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 15000,
  maxPoolSize: 10,
  minPoolSize: 2,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ MongoDB подключена'))
.catch(err => {
  console.error('❌ MongoDB ошибка подключения:', err.message);
  process.exit(1);
});

// События подключения
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB отключена');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB переподключена');
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB ошибка:', err.message);
});

// Схема
const SaveSchema = new mongoose.Schema({
  tgId:      { type: String, required: true, unique: true, index: true },
  username:  { type: String, default: '' },
  firstName: { type: String, default: '' },
  charId:    { type: String, default: null },
  data:      { type: mongoose.Schema.Types.Mixed, default: null },
  level:     { type: Number, default: 1 },
  cp:        { type: Number, default: 0 },
  floor:     { type: Number, default: 1 },
  updatedAt: { type: Number, default: 0 },
}, { 
  minimize: false,
  timestamps: true 
});

// Индексы для производительности
SaveSchema.index({ cp: -1, level: -1 });
SaveSchema.index({ updatedAt: 1 });
SaveSchema.index({ charId: 1 });

const Save = mongoose.model('Save', SaveSchema);

// ═══════════════════════════════
//  9. ВАЛИДАЦИЯ ИГРОВЫХ ДАННЫХ
// ═══════════════════════════════
function validateGameData(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'invalid_type' };
  }
  
  // Проверка обязательных полей
  if (!data.charId || typeof data.charId !== 'string') {
    return { valid: false, reason: 'missing_charId' };
  }
  
  // Проверка на отрицательные значения
  if (data.gold < 0 || data.pixr < 0 || data.gram < 0) {
    return { valid: false, reason: 'negative_currency' };
  }
  
  // Проверка лимитов
  if (data.level < GAME_LIMITS.minLevel || data.level > GAME_LIMITS.maxLevel) {
    return { valid: false, reason: 'invalid_level' };
  }
  
  if (data.gold > GAME_LIMITS.maxGold) {
    return { valid: false, reason: 'gold_overflow' };
  }
  
  if (data.pixr > GAME_LIMITS.maxPixr) {
    return { valid: false, reason: 'pixr_overflow' };
  }
  
  if (data.gram > GAME_LIMITS.maxGram) {
    return { valid: false, reason: 'gram_overflow' };
  }
  
  if (data.floor < 0 || data.floor > GAME_LIMITS.maxFloor) {
    return { valid: false, reason: 'invalid_floor' };
  }
  
  if (data.hp < GAME_LIMITS.minHp || data.hp > GAME_LIMITS.maxHp) {
    return { valid: false, reason: 'invalid_hp' };
  }
  
  // Проверка размера инвентаря
  if (data.inventory && Array.isArray(data.inventory)) {
    if (data.inventory.length > GAME_LIMITS.maxInventory) {
      return { valid: false, reason: 'inventory_overflow' };
    }
  }
  
  // Проверка equipped слотов
  if (data.equipped && typeof data.equipped === 'object') {
    const validSlots = ['weapon', 'armor', 'ring', 'boots', 'helmet'];
    for (const slot of Object.keys(data.equipped)) {
      if (!validSlots.includes(slot)) {
        return { valid: false, reason: 'invalid_equip_slot' };
      }
    }
  }
  
  // Проверка структуры baseStats
  if (data.baseStats && typeof data.baseStats === 'object') {
    const validStats = ['atk', 'def', 'hp', 'spd', 'crit', 'dodge'];
    for (const stat of Object.keys(data.baseStats)) {
      if (!validStats.includes(stat)) {
        return { valid: false, reason: 'invalid_stat' };
      }
      if (data.baseStats[stat] < 0 || data.baseStats[stat] > 999999) {
        return { valid: false, reason: 'stat_overflow' };
      }
    }
  }
  
  return { valid: true };
}

// ═══════════════════════════════
//  10. ПРОВЕРКА TELEGRAM
// ═══════════════════════════════
function verifyTelegram(initData) {
  if (!initData || typeof initData !== 'string') return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const botToken = process.env.BOT_TOKEN || '';
    const insecure = process.env.ALLOW_INSECURE === '1';

    if (!insecure) {
      if (!botToken) {
        console.error('❌ BOT_TOKEN не задан');
        return null;
      }
      const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();
      const calc = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');
      if (calc !== hash) {
        console.warn('⚠️ Invalid Telegram hash');
        return null;
      }
    }

    let user = null;
    try {
      user = JSON.parse(params.get('user') || 'null');
    } catch (e) {
      return null;
    }
    
    if (!user || !user.id) return null;

    return {
      id:        String(user.id),
      username:  user.username || '',
      firstName: user.first_name || '',
    };
  } catch (err) {
    console.error('❌ Telegram verification error:', err.message);
    return null;
  }
}

function authUser(req, res) {
  const tg = verifyTelegram(req.body?.initData);
  if (!tg) {
    res.status(401).json({ ok: false, error: 'auth_failed', message: 'Telegram authentication failed' });
    return null;
  }
  return tg;
}

// ═══════════════════════════════
//  11. РОУТЫ
// ═══════════════════════════════

// Health check
app.get('/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting'
  };
  
  res.json({
    ok: true,
    service: 'pixel-runner-rpg',
    version: '2.0.0',
    apiVersion: API_VERSION,
    environment: process.env.NODE_ENV || 'development',
    db: states[dbState] || 'unknown',
    uptime: Math.floor(process.uptime()),
    memory: {
      used: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    },
    timestamp: Date.now()
  });
});

// Корневой эндпоинт
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'pixel-runner-rpg',
    version: '2.0.0',
    db: mongoose.connection.readyState === 1,
    timestamp: Date.now()
  });
});

// Загрузка прогресса
app.post('/api/load', async (req, res) => {
  const tg = authUser(req, res);
  if (!tg) return;

  try {
    const doc = await Save.findOne({ tgId: tg.id })
      .select('charId data updatedAt -_id')
      .lean();
    
    res.json({
      ok: true,
      save: doc ? {
        charId: doc.charId,
        data: doc.data,
        updatedAt: doc.updatedAt || 0,
      } : null,
      user: {
        id: tg.id,
        username: tg.username,
        firstName: tg.firstName
      },
      serverTime: Date.now()
    });
  } catch (err) {
    console.error('❌ /api/load error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to load data' });
  }
});

// Сохранение прогресса
app.post('/api/save', saveLimiter, async (req, res) => {
  const tg = authUser(req, res);
  if (!tg) return;

  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ ok: false, error: 'bad_data', message: 'Missing or invalid data' });
  }

  // ВАЛИДАЦИЯ ИГРОВЫХ ДАННЫХ
  const validation = validateGameData(data);
  if (!validation.valid) {
    console.warn(`⚠️ Invalid game data from user ${tg.id}:`, validation.reason);
    return res.status(400).json({ 
      ok: false, 
      error: 'invalid_data',
      message: 'Invalid game data',
      reason: validation.reason
    });
  }

  const now = Date.now();
  const clientTs = Number(data.updatedAt) || now;

  try {
    // Проверяем текущую запись для разрешения конфликтов
    const existing = await Save.findOne({ tgId: tg.id }).lean();
    
    // Если есть более новые данные на сервере — не перезаписываем
    if (existing && existing.updatedAt > clientTs) {
      console.log(`⚠️ Conflict for user ${tg.id}: server=${existing.updatedAt}, client=${clientTs}`);
      return res.json({ 
        ok: true,
        updatedAt: existing.updatedAt,
        conflict: true,
        message: 'Server has newer data'
      });
    }

    // Сохраняем данные
    await Save.updateOne(
      { tgId: tg.id },
      {
        $set: {
          tgId: tg.id,
          username: tg.username,
          firstName: tg.firstName,
          charId: data.charId || null,
          data: data,
          level: Number(data.level) || 1,
          cp: Number(data.cp) || 0,
          floor: Number(data.floor) || 1,
          updatedAt: clientTs,
        }
      },
      { upsert: true }
    );
    
    res.json({ 
      ok: true, 
      updatedAt: clientTs,
      serverTime: now
    });
    
  } catch (err) {
    console.error('❌ /api/save error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to save data' });
  }
});

// Выбор персонажа
app.post('/api/character', async (req, res) => {
  const tg = authUser(req, res);
  if (!tg) return;

  const charId = req.body?.charId;
  if (!charId || typeof charId !== 'string') {
    return res.status(400).json({ ok: false, error: 'bad_char', message: 'Invalid character ID' });
  }

  // Проверяем, что персонаж существует (список валидных ID)
  const validChars = ['warrior', 'mage', 'rogue', 'archer', 'paladin']; // Замените на свои
  if (!validChars.includes(charId)) {
    return res.status(400).json({ ok: false, error: 'invalid_char', message: 'Character not found' });
  }

  try {
    await Save.updateOne(
      { tgId: tg.id },
      {
        $set: {
          tgId: tg.id,
          username: tg.username,
          firstName: tg.firstName,
          charId: charId,
          updatedAt: Date.now()
        }
      },
      { upsert: true }
    );
    
    res.json({ ok: true, message: 'Character selected' });
  } catch (err) {
    console.error('❌ /api/character error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to select character' });
  }
});

// Логирование ошибок с клиента
app.post('/api/log', async (req, res) => {
  const tg = verifyTelegram(req.body?.initData);
  
  const logData = req.body;
  
  console.error('📱 Client error:', {
    userId: tg?.id || 'unknown',
    username: tg?.username || 'unknown',
    type: logData?.type,
    message: logData?.data?.message,
    stack: logData?.data?.stack?.slice(0, 500),
    timestamp: logData?.timestamp,
    userAgent: logData?.userAgent,
    url: logData?.url
  });
  
  res.json({ ok: true });
});

// Лидерборд
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || LEADERBOARD_LIMIT, 100);
    
    const top = await Save.find({ 
      charId: { $ne: null },
      level: { $gt: 1 }
    })
      .sort({ cp: -1, level: -1 })
      .limit(limit)
      .select('username firstName level cp floor charId -_id')
      .lean();
    
    res.json({ 
      ok: true, 
      top: top.map((p, i) => ({
        ...p,
        rank: i + 1
      })),
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('❌ /api/leaderboard error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error', message: 'Failed to load leaderboard' });
  }
});

// Статистика сервера
app.get('/api/stats', async (req, res) => {
  try {
    const [
      totalPlayers,
      activePlayers,
      avgStats,
      topChar
    ] = await Promise.all([
      Save.countDocuments(),
      Save.countDocuments({ 
        updatedAt: { $gt: Date.now() - 7 * 24 * 60 * 60 * 1000 }
      }),
      Save.aggregate([
        { $match: { level: { $gt: 1 } } },
        { $group: { 
          _id: null, 
          avgLevel: { $avg: '$level' }, 
          avgCP: { $avg: '$cp' },
          maxCP: { $max: '$cp' },
          maxFloor: { $max: '$floor' }
        }}
      ]),
      Save.aggregate([
        { $match: { charId: { $ne: null } } },
        { $group: { _id: '$charId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 }
      ])
    ]);
    
    const stats = avgStats[0] || {};
    
    res.json({
      ok: true,
      totalPlayers,
      activePlayers: activePlayers + ' (7 days)',
      avgLevel: Math.round(stats.avgLevel || 0),
      avgCP: Math.round(stats.avgCP || 0),
      maxCP: stats.maxCP || 0,
      maxFloor: stats.maxFloor || 0,
      mostPopularChar: topChar[0]?._id || 'none',
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('❌ /api/stats error:', err.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    ok: false, 
    error: 'not_found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// ═══════════════════════════════
//  12. ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК
// ═══════════════════════════════
app.use((err, req, res, next) => {
  // Игнорируем ошибки обрыва соединения
  if (err.code === 'ECONNRESET' ||
      err.code === 'EPIPE' ||
      err.message?.includes('aborted') ||
      err.message?.includes('request aborted') ||
      err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return;
  }

  // Логируем все остальные ошибки
  console.error('❌ Unhandled error:', {
    url: req.url,
    method: req.method,
    error: err.message,
    stack: err.stack?.slice(0, 500),
    body: req.body ? JSON.stringify(req.body).slice(0, 200) : null
  });

  if (!res.headersSent) {
    res.status(500).json({ 
      ok: false, 
      error: 'internal_error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// ═══════════════════════════════
//  13. ОЧИСТКА СТАРЫХ ДАННЫХ
// ═══════════════════════════════
async function cleanupInactivePlayers() {
  try {
    const cutoff = Date.now() - (INACTIVE_DAYS * 24 * 60 * 60 * 1000);
    
    const result = await Save.deleteMany({
      updatedAt: { $lt: cutoff },
      level: { $lt: 5 },
      cp: { $lt: 100 }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned up ${result.deletedCount} inactive low-level players`);
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
  }
}

// Запускаем очистку раз в 24 часа
setInterval(cleanupInactivePlayers, 24 * 60 * 60 * 1000);

// ═══════════════════════════════
//  14. GRACEFUL SHUTDOWN
// ═══════════════════════════════
async function gracefulShutdown(signal) {
  console.log(`📴 ${signal} received. Starting graceful shutdown...`);
  
  // Закрываем HTTP сервер
  await new Promise((resolve) => {
    server.close(() => {
      console.log('🔌 HTTP server closed');
      resolve();
    });
  });
  
  // Закрываем соединение с MongoDB
  try {
    await mongoose.connection.close();
    console.log('🗄️ MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error closing MongoDB:', err.message);
  }
  
  console.log('✅ Shutdown complete');
  process.exit(0);
}

// Принудительное завершение через 10 секунд
function forceShutdown() {
  console.error('❌ Forced shutdown after timeout');
  process.exit(1);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
  setTimeout(forceShutdown, 10000);
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
  setTimeout(forceShutdown, 10000);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message);
  console.error(err.stack);
  gracefulShutdown('uncaughtException');
  setTimeout(forceShutdown, 10000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise);
  console.error('Reason:', reason);
});

// ═══════════════════════════════
//  15. ЗАПУСК СЕРВЕРА
// ═══════════════════════════════
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('═══════════════════════════════════');
  console.log(`🚀 Pixel Runner RPG Server`);
  console.log(`📡 Port: ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 Auth: ${process.env.ALLOW_INSECURE === '1' ? 'Development (insecure)' : 'Production (secure)'}`);
  console.log('═══════════════════════════════════');
});

// Настройка таймаутов
server.timeout = 120000;          // 2 минуты на ответ
server.keepAliveTimeout = 65000;  // Дольше чем у Railway
server.headersTimeout = 66000;    // Должен быть > keepAliveTimeout

// Обработка ошибок сервера
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error('❌ Server error:', err.message);
});

module.exports = app;