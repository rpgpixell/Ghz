/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой (Socket.io)
  ══════════════════════════════════════════════════════
*/

(function() {
  'use strict';

  const API_URL = 'https://ghz-production.up.railway.app';
  let socket = null;
  let connected = false;
  let connecting = false;
  let tgId = null;
  let G = window.G || {};

  // ── ПОЛУЧИТЬ TG ID ──
  function getTgId() {
    try {
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe) {
        const user = window.Telegram.WebApp.initDataUnsafe.user;
        if (user && user.id) {
          return String(user.id);
        }
      }
    } catch (e) {}
    return null;
  }

  // ── ПОЛУЧИТЬ INIT DATA ──
  function getInitData() {
    try {
      if (window.Telegram && window.Telegram.WebApp) {
        return window.Telegram.WebApp.initData || '';
      }
    } catch (e) {}
    return '';
  }

  // ── ПОДКЛЮЧЕНИЕ ──
  function connect(callback) {
    if (socket && connected) {
      if (callback) callback(null);
      return;
    }

    if (connecting) {
      if (callback) {
        const check = setInterval(() => {
          if (connected || !connecting) {
            clearInterval(check);
            callback(connected ? null : new Error('timeout'));
          }
        }, 100);
      }
      return;
    }

    tgId = getTgId();
    if (!tgId) {
      console.warn('⚠️ [socket] Нет tgId');
      if (callback) callback(new Error('no_tg_id'));
      return;
    }

    connecting = true;
    const initData = getInitData();

    if (typeof io === 'undefined') {
      console.error('❌ [socket] io не определён!');
      connecting = false;
      if (callback) callback(new Error('socket_not_loaded'));
      return;
    }

    socket = io(API_URL, {
      auth: { initData },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socket.on('connect', () => {
      console.log('🟢 [socket] Подключен');
      connected = true;
      connecting = false;
      if (callback) callback(null);
    });

    socket.on('connect_error', (err) => {
      console.error('❌ [socket] Ошибка:', err.message);
      connected = false;
      connecting = false;
      if (callback) callback(err);
    });

    socket.on('disconnect', (reason) => {
      console.warn(`⚠️ [socket] Отключен: ${reason}`);
      connected = false;
    });

    socket.io.on('reconnect', () => {
      console.log('🔄 [socket] Переподключен');
      connected = true;
    });

    socket.io.on('reconnect_error', (err) => {
      console.error('❌ [socket] Ошибка переподключения:', err.message);
    });
  }

  // ── ЗАГРУЗКА ──
  function loadGame(callback) {
    function doLoad() {
      if (!socket || !connected) {
        return callback({ ok: false, error: 'offline' });
      }
      socket.emit('load', (response) => {
        if (response.ok) {
          if (response.save && response.save.data) {
            applySnapshot(response.save.data);
            if (response.save.charId && typeof applyCharacterSprites === 'function') {
              const CHARS = window.CHARS || {};
              if (CHARS[response.save.charId]) {
                applyCharacterSprites(CHARS[response.save.charId]);
              }
            }
          }
          callback({ ok: true, save: response.save });
        } else {
          callback({ ok: false, error: response.error });
        }
      });
    }

    if (!socket || !connected) {
      connect((err) => {
        if (err) return callback({ ok: false, error: err.message });
        doLoad();
      });
    } else {
      doLoad();
    }
  }

  // ── СОХРАНЕНИЕ (каждую секунду) ──
  function saveGame(data, callback) {
    if (!socket || !connected) {
      saveLocal(data);
      if (callback) callback({ ok: false, error: 'offline', local: true });
      return;
    }

    socket.emit('save', data, (response) => {
      if (response && response.ok) {
        if (callback) callback({ ok: true });
      } else {
        saveLocal(data);
        if (callback) callback({ ok: false, error: response?.error || 'save_failed', local: true });
      }
    });
  }

  // ── МГНОВЕННОЕ СОХРАНЕНИЕ ──
  function saveInstant(data, callback) {
    if (!socket || !connected) {
      saveLocal(data);
      if (callback) callback({ ok: false, error: 'offline', local: true });
      return;
    }

    socket.emit('save_instant', data, (response) => {
      if (callback) callback(response || { ok: false });
    });
  }

  // ── ЛОКАЛЬНОЕ ХРАНЕНИЕ (резерв) ──
  const LS_KEY = 'pixrpg_save_v2';

  function saveLocal(data) {
    try {
      let full = {};
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        try { full = JSON.parse(raw); } catch (e) {}
      }
      Object.assign(full, data);
      full._savedAt = Date.now();
      localStorage.setItem(LS_KEY, JSON.stringify(full));
    } catch (e) {}
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && data._savedAt && (Date.now() - data._savedAt) > 7 * 24 * 3600 * 1000) {
        return null;
      }
      return data;
    } catch (e) { return null; }
  }

  function clearLocal() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  // ── ПРИМЕНЕНИЕ СНАПШОТА ──
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return false;
    
    const localG = window.G;
    if (!localG) return false;

    // Применяем данные к G
    Object.keys(s).forEach(key => {
      if (key !== '_savedAt' && key !== '_offlineOnly') {
        localG[key] = s[key];
      }
    });

    // Пересчёт
    if (typeof recalcStats === 'function') recalcStats();
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof updatePotionHud === 'function') updatePotionHud();

    return true;
  }

  // ── ВЫБОР ПЕРСОНАЖА ──
  function selectCharacter(charId, callback) {
    if (!socket || !connected) {
      saveLocal({ charId });
      if (callback) callback({ ok: true, local: true });
      return;
    }

    socket.emit('select_character', charId, (response) => {
      if (callback) callback(response || { ok: false });
    });
  }

  // ── ЛИДЕРБОРД ──
  function getLeaderboard(callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('leaderboard', (response) => {
      callback(response || { ok: false });
    });
  }

  // ── РЕФЕРАЛЫ ──
  function getRefFriends(callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('ref_friends', (response) => {
      callback(response || { ok: false });
    });
  }

  function claimRefReward(callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('ref_claim', (response) => {
      callback(response || { ok: false });
    });
  }

  // ── ТРАНЗАКЦИИ ──
  function deposit(amount, callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('deposit', amount, (response) => {
      callback(response || { ok: false });
    });
  }

  function withdraw(data, callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('withdraw', data, (response) => {
      callback(response || { ok: false });
    });
  }

  function getTransactions(callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('get_transactions', (response) => {
      callback(response || { ok: false });
    });
  }

  // ── ЗАДАНИЯ ──
  function getTasks(callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('get_tasks', (response) => {
      callback(response || { ok: false });
    });
  }

  function claimDailyTask(milestoneId, callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('claim_daily_task', milestoneId, (response) => {
      callback(response || { ok: false });
    });
  }

  function claimSpecialTask(taskId, callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('claim_special_task', taskId, (response) => {
      callback(response || { ok: false });
    });
  }

  // ── ОБМЕН PIXR → GRAM ──
  function exchangePixr(amount, callback) {
    if (!socket || !connected) {
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('exchange_pixr', amount, (response) => {
      callback(response || { ok: false });
    });
  }

  // ── ПРОВЕРКА СТАТУСА ──
  function isConnected() { return connected; }

  function getSocket() { return socket; }

  // ═══════════════════════════════════
  //  АВТОМАТИЧЕСКОЕ ПОДКЛЮЧЕНИЕ
  // ═══════════════════════════════════

  function autoConnect() {
    const id = getTgId();
    if (id) {
      tgId = id;
      connect();
    }
  }

  // ── ИНИЦИАЛИЗАЦИЯ ──
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    autoConnect();
  } else {
    document.addEventListener('DOMContentLoaded', autoConnect);
  }

  // ═══════════════════════════════════
  //  ЭКСПОРТ
  // ═══════════════════════════════════

  window.GameSocket = {
    connect,
    loadGame,
    saveGame,
    saveInstant,
    selectCharacter,
    getLeaderboard,
    getRefFriends,
    claimRefReward,
    deposit,
    withdraw,
    getTransactions,
    getTasks,
    claimDailyTask,
    claimSpecialTask,
    exchangePixr,
    getTgId,
    getInitData,
    applySnapshot,
    saveLocal,
    loadLocal,
    clearLocal,
    isConnected,
    getSocket,
  };

  console.log('🔌 [net] GameSocket инициализирован');
})();