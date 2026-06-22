/*
  ══════════════════════════════════════════════════════
  api.js — Клиентский модуль сохранения/загрузки
  Pixel Runner RPG

  Подключается ПЕРВЫМ после data.js/state.js.
  Экспортирует глобальные функции:
    API.init()          — авторизация при старте
    API.save()          — полное сохранение G
    API.partial(fields) — частичный патч
    API.loaded          — флаг: данные загружены
  ══════════════════════════════════════════════════════
*/

const API = (function() {
  'use strict';

  const BASE_URL = 'https://ghz-production.up.railway.app';

  let _initData = '';   // Telegram initData строка
  let _userId   = '';   // userId после авторизации
  let _saveTimer = null;
  let _dirty     = false;

  // Получаем initData из Telegram SDK или из URL (для тестов)
  function getInitData() {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
      return window.Telegram.WebApp.initData;
    }
    // Тестовый режим: ?initData=... в URL
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('initData') || '';
  }

  // ── Универсальный fetch с авторизацией ──
  async function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (_initData) {
      opts.headers['Authorization'] = 'tma ' + _initData;
    }
    opts.headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE_URL + path, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    return res.json();
  }

  // ══════════════════════════════════════════════════════
  //  Применение сохранения к объекту G
  // ══════════════════════════════════════════════════════
  function applySave(save) {
    if (!save) return;

    // Скалярные поля
    var scalars = [
      'gold','pixr','gram','level','xp','xpNeeded',
      'floor','maxFloor','killCount','hp','maxHp',
      'potionLv','potions','potionThreshold',
    ];
    scalars.forEach(function(k) {
      if (save[k] !== undefined && save[k] !== null) G[k] = save[k];
    });

    // Вложенные объекты
    if (save.baseStats) Object.assign(G.baseStats, save.baseStats);
    if (save.stats)     Object.assign(G.stats,     save.stats);
    if (save.upg)       Object.assign(G.upg,       save.upg);
    if (save.equipped)  Object.assign(G.equipped,  save.equipped);

    // BP
    if (save.bp) {
      G.bp = { active: !!save.bp.active, claimed: save.bp.claimed || [] };
    }
    // Premium
    if (save.prem) {
      G.prem = { tier: save.prem.tier || null, expiresAt: save.prem.expiresAt || 0 };
    }
    // Инвентарь
    if (Array.isArray(save.inventory)) {
      G.inventory = save.inventory;
    }
    // Навыки
    if (save.skills && typeof save.skills === 'object') {
      G.skills = save.skills;
    }

    // charId — вернём его, чтобы ui.js мог применить персонажа
    return save.charId || null;
  }

  // ══════════════════════════════════════════════════════
  //  Сборка снапшота G для отправки
  // ══════════════════════════════════════════════════════
  function buildSnapshot() {
    return {
      charId:    window.G_CHAR ? window.G_CHAR.id : null,
      gold:      G.gold,
      pixr:      G.pixr,
      gram:      G.gram,
      level:     G.level,
      xp:        G.xp,
      xpNeeded:  G.xpNeeded,
      floor:     G.floor,
      maxFloor:  G.maxFloor,
      killCount: G.killCount,
      hp:        G.hp,
      maxHp:     G.maxHp,
      baseStats: Object.assign({}, G.baseStats),
      stats:     Object.assign({}, G.stats),
      upg:       Object.assign({}, G.upg),
      potionLv:  G.potionLv || 0,
      potions:   G.potions  || 0,
      potionThreshold: G.potionThreshold || 30,
      bp:        { active: G.bp.active, claimed: G.bp.claimed.slice() },
      prem:      { tier: G.prem.tier, expiresAt: G.prem.expiresAt },
      inventory: G.inventory.slice(),
      equipped:  Object.assign({}, G.equipped),
      skills:    Object.assign({}, G.skills),
    };
  }

  // ══════════════════════════════════════════════════════
  //  Публичное API
  // ══════════════════════════════════════════════════════

  /**
   * Инициализация: авторизация + загрузка сохранения.
   * Возвращает charId (или null для нового игрока).
   */
  async function init() {
    _initData = getInitData();
    if (!_initData) {
      console.warn('[API] No initData — offline mode');
      return null;
    }
    try {
      const res = await apiFetch('/auth', {
        method: 'POST',
        body: JSON.stringify({ initData: _initData }),
      });
      _userId = res.userId;
      console.log('[API] Auth OK, userId=' + _userId + ', isNew=' + res.isNew);

      const charId = applySave(res.save);

      // Запускаем автосохранение каждые 30 сек
      _saveTimer = setInterval(function() {
        if (_dirty) { save(); _dirty = false; }
      }, 30000);

      return charId;
    } catch (e) {
      console.error('[API] Auth failed:', e.message);
      return null;
    }
  }

  /**
   * Полное сохранение — при выходе из игры, смерти, смене этажа.
   */
  async function save() {
    if (!_initData) return;
    try {
      await apiFetch('/save', {
        method: 'POST',
        body: JSON.stringify(buildSnapshot()),
      });
      console.log('[API] Save OK');
    } catch (e) {
      console.error('[API] Save failed:', e.message);
    }
  }

  /**
   * Частичное сохранение — для быстрых изменений (золото, XP).
   * @param {Object} fields — только изменившиеся поля
   */
  async function partial(fields) {
    if (!_initData) return;
    _dirty = false;
    try {
      await apiFetch('/save/partial', {
        method: 'POST',
        body: JSON.stringify({ fields: fields }),
      });
    } catch (e) {
      console.error('[API] Partial save failed:', e.message);
    }
  }

  /**
   * Помечает состояние как изменённое (для автосохранения).
   */
  function markDirty() {
    _dirty = true;
  }

  return {
    init:       init,
    save:       save,
    partial:    partial,
    markDirty:  markDirty,
    get loaded() { return !!_userId; },
    get userId() { return _userId; },
  };
})();
