/*
  ══════════════════════════════════════════════════════
  net.js — Сетевой слой (Socket.io) — ТОЛЬКО ОНЛАЙН
  БЕЗ localStorage, БЕЗ офлайн-режима
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

  // ── ПРОВЕРКА ИНТЕРНЕТА ──
  function isOnline() {
    return navigator.onLine && connected;
  }

  // ── ПОКАЗАТЬ ОШИБКУ ОФЛАЙН ──
  function showOfflineError() {
    const msg = '❌ Нет соединения с сервером!\nПроверьте интернет.';
    const el = document.getElementById('floorUnlock');
    if (el) {
      el.querySelector('.fu-title').textContent = '⚠️ ' + msg;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 4000);
    }
    console.error('❌ [socket] Офлайн, данные не сохранены');
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
      reconnectionAttempts: 5, // ← ограничиваем попытки
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
      showOfflineError();
      if (callback) callback(err);
    });

    socket.on('disconnect', (reason) => {
      console.warn(`⚠️ [socket] Отключен: ${reason}`);
      connected = false;
      showOfflineError();
    });

    socket.io.on('reconnect', () => {
      console.log('🔄 [socket] Переподключен');
      connected = true;
    });

    socket.io.on('reconnect_error', (err) => {
      console.error('❌ [socket] Ошибка переподключения:', err.message);
      showOfflineError();
    });

    socket.io.on('reconnect_failed', () => {
      console.error('❌ [socket] Не удалось переподключиться');
      showOfflineError();
    });
  }

  // ── ЗАГРУЗКА (ТОЛЬКО С СЕРВЕРА) ──
  function loadGame(callback) {
    if (!socket || !connected) {
      showOfflineError();
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

  // ── СОХРАНЕНИЕ (ТОЛЬКО НА СЕРВЕР) ──
  function saveGame(data, callback) {
    if (!socket || !connected) {
      showOfflineError();
      if (callback) callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('save', data, (response) => {
      if (response && response.ok) {
        if (callback) callback({ ok: true });
      } else {
        console.error('❌ [save] Ошибка сервера:', response?.error);
        if (callback) callback({ ok: false, error: response?.error || 'save_failed' });
      }
    });
  }

  // ── МГНОВЕННОЕ СОХРАНЕНИЕ (ТОЛЬКО НА СЕРВЕР) ──
  function saveInstant(data, callback) {
    if (!socket || !connected) {
      showOfflineError();
      if (callback) callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('save_instant', data, (response) => {
      if (callback) callback(response || { ok: false });
    });
  }

  // ── ПРИМЕНЕНИЕ СНАПШОТА ──
  function applySnapshot(s) {
    if (!s || typeof s !== 'object') return false;
    
    const localG = window.G;
    if (!localG) return false;

    Object.keys(s).forEach(key => {
      if (key !== '_savedAt' && key !== '_offlineOnly') {
        localG[key] = s[key];
      }
    });

    if (typeof recalcStats === 'function') recalcStats();
    if (typeof updateHUD === 'function') updateHUD();
    if (typeof updatePotionHud === 'function') updatePotionHud();

    return true;
  }

  // ── ВЫБОР ПЕРСОНАЖА ──
  function selectCharacter(charId, callback) {
    if (!socket || !connected) {
      showOfflineError();
      if (callback) callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('select_character', charId, (response) => {
      if (callback) callback(response || { ok: false });
    });
  }

  // ── ЛИДЕРБОРД ──
  function getLeaderboard(callback) {
    if (!socket || !connected) {
      showOfflineError();
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
      showOfflineError();
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('ref_friends', (response) => {
      callback(response || { ok: false });
    });
  }

  function claimRefReward(callback) {
    if (!socket || !connected) {
      showOfflineError();
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
      showOfflineError();
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('deposit', amount, (response) => {
      callback(response || { ok: false });
    });
  }

  function withdraw(data, callback) {
    if (!socket || !connected) {
      showOfflineError();
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('withdraw', data, (response) => {
      callback(response || { ok: false });
    });
  }

  function getTransactions(callback) {
    if (!socket || !connected) {
      showOfflineError();
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
      showOfflineError();
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('get_tasks', (response) => {
      callback(response || { ok: false });
    });
  }

  function claimDailyTask(milestoneId, callback) {
    if (!socket || !connected) {
      showOfflineError();
      callback({ ok: false, error: 'offline' });
      return;
    }

    socket.emit('claim_daily_task', milestoneId, (response) => {
      callback(response || { ok: false });
    });
  }

  function claimSpecialTask(taskId, callback) {
    if (!socket || !connected) {
      showOfflineError();
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
      showOfflineError();
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

  // ── ОТПРАВКА СОБЫТИЙ ──
  function emit(event, data, callback) {
    if (!socket || !connected) {
      showOfflineError();
      if (callback) callback({ ok: false, error: 'offline' });
      return;
    }
    socket.emit(event, data, callback);
  }

  // ═══════════════════════════════════
  //  АВТОМАТИЧЕСКОЕ ПОДКЛЮЧЕНИЕ
  // ═══════════════════════════════════

  function autoConnect() {
    const id = getTgId();
    if (id) {
      tgId = id;
      connect((err) => {
        if (err) {
          showOfflineError();
        }
      });
    }
  }

  // ── СЛУШАЕМ ИЗМЕНЕНИЕ СТАТУСА ИНТЕРНЕТА ──
  window.addEventListener('online', () => {
    console.log('🌐 Интернет появился, подключаемся...');
    if (!connected) {
      connect();
    }
  });

  window.addEventListener('offline', () => {
    console.warn('🌐 Интернет пропал');
    connected = false;
    showOfflineError();
  });

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
    // Подключение
    connect,
    isConnected,
    getSocket,
    getTgId,
    getInitData,
    isOnline,
    
    // Загрузка/сохранение
    loadGame,
    saveGame,
    saveInstant,
    applySnapshot,
    
    // Игрок
    selectCharacter,
    
    // Лидерборд
    getLeaderboard,
    
    // Рефералы
    getRefFriends,
    claimRefReward,
    
    // Транзакции
    deposit,
    withdraw,
    getTransactions,
    
    // Задания
    getTasks,
    claimDailyTask,
    claimSpecialTask,
    
    // Обмен
    exchangePixr,
    
    // Универсальный emit
    emit,
  };

  console.log('🔌 [net] GameSocket инициализирован (ТОЛЬКО ОНЛАЙН)');
  console.log('📡 API_URL:', API_URL);

})();