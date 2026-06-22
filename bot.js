/*
  ══════════════════════════════════════════════════════
  bot.js — Telegram бот для PIXEL RPG
  ───
  Команды:
  /start — приветствие с кнопкой запуска игры
  /help — справка
  /ref — реферальная ссылка
  /profile — профиль игрока
  ══════════════════════════════════════════════════════
*/

const TelegramBot = require('node-telegram-bot-api');

let bot = null;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'YourBotUsername';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-domain.com';

if (!BOT_TOKEN) {
  console.warn('⚠️ BOT_TOKEN не задан — бот не запущен');
}

// ── Инициализация бота ──
function initBot(app) {
  if (!BOT_TOKEN) {
    console.warn('⚠️ Бот не инициализирован: нет BOT_TOKEN');
    return null;
  }

  try {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log('✅ Telegram бот запущен');

    // ── /start ──
    bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || msg.from.first_name || 'Игрок';
      const startParam = match && match[1] ? match[1] : null;
      
      console.log(`📨 /start от ${username} (${userId}), param: ${startParam || 'none'}`);
      
      let webappUrl = WEBAPP_URL;
      if (startParam) {
        webappUrl += `?startapp=${startParam}`;
      }
      
      const message = `
${getGreeting(username)}

🔥 **PIXEL RPG** — эпическая RPG в стиле пиксель-арт!

━━━━━━━━━━━━━━━━━━━
🎮 **В игре тебя ждут:**
  ✦ 10 уникальных этажей с монстрами
  ✦ 3 класса персонажей (Огонь, Свет, Вода)
  ✦ Система улучшений и навыков
  ✦ Редкие предметы и заточка
  ✦ Боевой пропуск и премиум статус
  ✦ Реферальная система — приглашай друзей!

━━━━━━━━━━━━━━━━━━━
👤 **Твой ID:** \`${userId}\`
${startParam ? `🔗 **Пригласил:** \`${startParam}\`` : ''}

Нажми на кнопку ниже, чтобы начать приключение!
      `;

      const options = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎮 ИГРАТЬ',
                web_app: { url: webappUrl }
              }
            ],
            [
              {
                text: '👥 Пригласить друзей',
                callback_data: 'ref'
              },
              {
                text: '📊 Статистика',
                callback_data: 'profile'
              }
            ]
          ]
        }
      };

      bot.sendMessage(chatId, message, options);
    });

    // ── /help ──
    bot.onText(/\/help/, (msg) => {
      bot.sendMessage(msg.chat.id, `
📖 **Справка по командам:**

/start — Начать игру
/help — Эта справка
/ref — Реферальная ссылка
/profile — Мой профиль
      `, { parse_mode: 'Markdown' });
    });

    // ── /ref ──
    bot.onText(/\/ref/, (msg) => {
      const userId = msg.from.id;
      const refLink = `https://t.me/${BOT_USERNAME}?startapp=${userId}`;
      bot.sendMessage(msg.chat.id, `
👥 **Твоя реферальная ссылка:**

\`${refLink}\`

📌 **Как это работает:**
1. Отправь ссылку другу
2. Друг переходит по ссылке и запускает игру
3. Ты получаешь +500 золота за каждые 5 уровней друга!

💰 **Твой бонус:** ${await getPendingReward(userId)} золота
      `, { parse_mode: 'Markdown' });
    });

    // ── /profile ──
    bot.onText(/\/profile/, async (msg) => {
      const userId = msg.from.id;
      const profile = await getPlayerProfile(userId);
      bot.sendMessage(msg.chat.id, `
📊 **Твой профиль:**

👤 Имя: ${profile.username}
🎯 Уровень: ${profile.level}
⚔️ Боевая мощь: ${profile.cp}
🏰 Этаж: ${profile.floor}
👾 Убийств: ${profile.killCount}
🪙 Золото: ${profile.gold}
💎 PIXR: ${profile.pixr}
⭐ GRAM: ${profile.gram}
      `, { parse_mode: 'Markdown' });
    });

    // ── Callback кнопки ──
    bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const userId = query.from.id;
      const data = query.data;
      
      try {
        await bot.answerCallbackQuery(query.id);
        
        if (data === 'ref') {
          const refLink = `https://t.me/${BOT_USERNAME}?startapp=${userId}`;
          await bot.sendMessage(chatId, `
👥 **Твоя реферальная ссылка:**

\`${refLink}\`

📌 **Как это работает:**
1. Отправь ссылку другу
2. Друг переходит по ссылке и запускает игру
3. Ты получаешь +500 золота за каждые 5 уровней друга!

💰 **Твой бонус:** ${await getPendingReward(userId)} золота
          `, { parse_mode: 'Markdown' });
        } else if (data === 'profile') {
          const profile = await getPlayerProfile(userId);
          await bot.sendMessage(chatId, `
📊 **Твой профиль:**

👤 Имя: ${profile.username}
🎯 Уровень: ${profile.level}
⚔️ Боевая мощь: ${profile.cp}
🏰 Этаж: ${profile.floor}
👾 Убийств: ${profile.killCount}
🪙 Золото: ${profile.gold}
💎 PIXR: ${profile.pixr}
⭐ GRAM: ${profile.gram}
          `, { parse_mode: 'Markdown' });
        }
      } catch (e) {
        console.error('❌ [callback] error:', e.message);
      }
    });

    // ── Ошибки ──
    bot.on('polling_error', (error) => {
      console.error('❌ Бот polling error:', error.message);
    });

    return bot;

  } catch (e) {
    console.error('❌ Ошибка инициализации бота:', e.message);
    return null;
  }
}

// ═══════════════════════════════
//  Вспомогательные функции
// ═══════════════════════════════

function getGreeting(username) {
  const hour = new Date().getHours();
  let timeGreeting = 'Добрый день';
  if (hour < 12) timeGreeting = '🌅 Доброе утро';
  else if (hour < 18) timeGreeting = '☀️ Добрый день';
  else if (hour < 22) timeGreeting = '🌇 Добрый вечер';
  else timeGreeting = '🌙 Доброй ночи';
  
  const greetings = [
    `${timeGreeting}, *${username}*! 👋`,
    `${timeGreeting}, *${username}*! Рады тебя видеть! ✨`,
    `${timeGreeting}, *${username}*! Добро пожаловать в PIXEL RPG! 🎮`,
    `${timeGreeting}, *${username}*! Приключение начинается! ⚔️`,
    `${timeGreeting}, *${username}*! Готов к битве? 🔥`,
  ];
  
  return greetings[Math.floor(Math.random() * greetings.length)];
}

// ── Получение профиля из MongoDB ──
async function getPlayerProfile(userId) {
  try {
    const mongoose = require('mongoose');
    const Save = mongoose.model('Save');
    
    const doc = await Save.findOne({ tgId: String(userId) }).lean();
    if (!doc) {
      return {
        username: 'Новичок',
        level: 1,
        cp: 0,
        floor: 1,
        killCount: 0,
        gold: 0,
        pixr: 0,
        gram: 0,
      };
    }
    
    const data = doc.data || {};
    return {
      username: doc.firstName || doc.username || 'Игрок',
      level: doc.level || 1,
      cp: doc.cp || 0,
      floor: doc.floor || 1,
      killCount: data.killCount || 0,
      gold: data.gold || 0,
      pixr: data.pixr || 0,
      gram: data.gram || 0,
    };
  } catch (e) {
    console.error('❌ [getPlayerProfile] error:', e.message);
    return {
      username: 'Ошибка',
      level: 0,
      cp: 0,
      floor: 0,
      killCount: 0,
      gold: 0,
      pixr: 0,
      gram: 0,
    };
  }
}

// ── Получение pending награды ──
async function getPendingReward(userId) {
  try {
    const mongoose = require('mongoose');
    const Save = mongoose.model('Save');
    
    const doc = await Save.findOne({ tgId: String(userId) }).lean();
    if (!doc) return 0;
    
    const friends = await Save.find({ refBy: String(userId) })
      .select('level -_id').lean();
    
    const milestones = doc.refMilestones || {};
    let total = 0;
    
    friends.forEach(f => {
      const paid = milestones[f.tgId] || 0;
      const maxMilestone = Math.floor(f.level / 5) * 5;
      if (maxMilestone > paid) {
        total += ((maxMilestone - paid) / 5) * 500;
      }
    });
    
    return total;
  } catch (e) {
    console.error('❌ [getPendingReward] error:', e.message);
    return 0;
  }
}

// ── Остановка бота ──
function stopBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
    console.log('🛑 Бот остановлен');
  }
}

// ── Экспорт ──
module.exports = {
  initBot,
  stopBot,
  get bot() { return bot; }
};