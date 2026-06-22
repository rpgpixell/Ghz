/*
  ══════════════════════════════════════════════════════
  bot.js — Telegram Bot для Pixel Runner RPG
  Webhook режим (оптимально для Railway)

  Команды:
    /start          — приветствие + кнопка открыть игру
    /start ref123   — пришёл по реферальной ссылке
    /help           — краткая помощь

  ENV (Railway -> Variables):
    BOT_TOKEN         — токен бота из @BotFather (обязательно)
    BOT_USERNAME      — username бота без @ (обязательно)
    MINI_APP_URL      — URL фронтенда, напр. https://user.github.io/pixel-runner
    WEBHOOK_SECRET    — секрет для URL вебхука (если не задан — берётся из токена)
    RAILWAY_PUBLIC_DOMAIN — задаётся Railway автоматически

  Подключение: вызвать initBot(app) ПОСЛЕ всех роутов в server.js
  ══════════════════════════════════════════════════════
*/

const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN      = process.env.BOT_TOKEN      || '';
const BOT_USERNAME   = process.env.BOT_USERNAME   || 'YourBotUsername';
const MINI_APP_URL   = (process.env.MINI_APP_URL  || '').replace(/\/$/, '');
// Используем вторую часть токена как секрет (достаточно для защиты URL вебхука)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || (BOT_TOKEN.split(':')[1] || 'pixelrunner');

// ── Тексты ──
function welcomeText(firstName) {
  // MarkdownV2: экранируем спецсимволы . ! ( ) - _
  const name = firstName.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
  return (
    `⚔️ *Привет, ${name}\\!*\n\n` +
    `Добро пожаловать в *Pixel Runner RPG* — pixel\\-art RPG прямо в Telegram\\!\n\n` +
    `🧙 Выбери персонажа из трёх классов\n` +
    `🗡️ Убивай монстров, собирай экипировку\n` +
    `⬆️ Прокачивай навыки и характеристики\n` +
    `🏆 Поднимайся по этажам и соревнуйся с другими\n\n` +
    `_Прогресс сохраняется автоматически_`
  );
}

function helpText() {
  return (
    `*Pixel Runner RPG — помощь*\n\n` +
    `🎮 /start — открыть игру\n\n` +
    `*Как пригласить друга:*\n` +
    `Зайди в игру → вкладка Друзья → скопируй реферальную ссылку\\.\n` +
    `За каждые *5 уровней* друга получаешь *500 золота*\\.`
  );
}

// ── Инициализация ──
function initBot(app) {
  if (!BOT_TOKEN) {
    console.warn('⚠️  BOT_TOKEN не задан — бот отключён');
    return null;
  }
  if (!MINI_APP_URL) {
    console.warn('⚠️  MINI_APP_URL не задан — кнопка игры не будет работать');
  }

  const bot = new TelegramBot(BOT_TOKEN);

  // ── Webhook endpoint ──
  const webhookPath = `/bot/${WEBHOOK_SECRET}`;
  app.post(webhookPath, (req, res) => {
    try { bot.processUpdate(req.body); } catch (e) { console.error('bot update error:', e.message); }
    res.sendStatus(200);
  });

  // ── Устанавливаем webhook на Railway ──
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL || '';
  if (domain) {
    const webhookUrl = `https://${domain}${webhookPath}`;
    bot.setWebHook(webhookUrl)
      .then(() => console.log(`✅ Webhook: ${webhookUrl}`))
      .catch(err => console.error('❌ setWebHook error:', err.message));
  } else {
    console.warn('⚠️  RAILWAY_PUBLIC_DOMAIN не найден — установи webhook вручную:');
    console.warn(`   https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=ТВОЙ_URL${webhookPath}`);
  }

  // ═══════════════════════════════
  //  /start [param]
  // ═══════════════════════════════
  bot.onText(/^\/start(.*)$/, async (msg, match) => {
    const chatId   = msg.chat.id;
    const userId   = String(msg.from.id);
    const param    = (match[1] || '').trim();
    const firstName = msg.from.first_name || 'Игрок';

    // Строим URL мини-аппа
    // Если пришёл по реферальной ссылке (/start ref123456) — передаём реф в URL
    // Мини-апп прочитает его через window.location.search (?ref=123456)
    let appUrl = MINI_APP_URL || `https://t.me/${BOT_USERNAME}`;
    if (param && param !== userId) {
      appUrl += '?ref=' + encodeURIComponent(param);
    }

    try {
      await bot.sendMessage(chatId, welcomeText(firstName), {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎮  Играть', web_app: { url: appUrl } },
          ]],
        },
      });
    } catch (e) {
      console.error('sendMessage /start error:', e.message);
    }
  });

  // ═══════════════════════════════
  //  /help
  // ═══════════════════════════════
  bot.onText(/^\/help$/, async (msg) => {
    try {
      await bot.sendMessage(msg.chat.id, helpText(), { parse_mode: 'MarkdownV2' });
    } catch (e) {
      console.error('sendMessage /help error:', e.message);
    }
  });

  // ═══════════════════════════════
  //  Любое другое сообщение
  // ═══════════════════════════════
  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // уже обработано
    try {
      await bot.sendMessage(msg.chat.id, welcomeText(msg.from.first_name || 'Игрок'), {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎮  Играть', web_app: { url: MINI_APP_URL || `https://t.me/${BOT_USERNAME}` } },
          ]],
        },
      });
    } catch (e) {}
  });

  console.log('✅ Бот инициализирован');
  return bot;
}

module.exports = { initBot };
