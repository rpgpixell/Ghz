/*
  ══════════════════════════════════════════════════════
  api.js — Клиентский модуль сохранения/загрузки
  Pixel Runner RPG

  Стратегия сохранений:
  1. Сервер — единственный источник истины
  2. Автосохранение каждые 20 сек
  3. При старте — загрузка с сервера
  4. sendBeacon при закрытии

  API.init()          — авторизация + загрузка с сервера
  API.save()          — полное сохранение на сервер
  API.saveBeacon()    — sendBeacon при закрытии
  API.partial(fields) — частичный патч сервера
  API.markDirty()     — пометить, что нужно сохранить
  API.savedHp         — HP из сохранения (до applyCharacter)
  ══════════════════════════════════════════════════════
*/

const API = (function() {
  'use strict';

  const BASE_URL = 'https://ghz-production.up.railway.app';

  let _initData = '';
  let _userId = '';
  let _photoUrl = '';
  let _firstName = '';
  let _saveTimer = null;
  let _dirty = false;
  let _savedHp = null;

  function getInitData() {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) {
      return window.Telegram.WebApp.initData;
    }
    var urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('initData') || '';
  }

  // ── fetch с авторизацией ──
  async function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (_initData) opts.headers['Authorization'] = 'tma ' + _initData;
    opts.headers['Content-Type'] = 'application/json';
    var res = await fetch(BASE_URL + path, opts);
    if (!res.ok) {
      var body = await res.json().catch(function() { return {}; });
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    return res.json();
  }

  // ══════════════════════════════════════════════════════
  //  Применение сохранения к G
  //  HP запоминаем в _savedHp — восстановим ПОСЛЕ applyCharacter
  // ══════════════════════════════════════════════════════
  function applySave(save) {
    if (!save) return null;

    var scalars = [
      'gold','pixr','gram','level','xp','xpNeeded',
      'floor','maxFloor','killCount',
      'potionLv','potions','potionThreshold',
    ];
    scalars.forEach(function(k) {
      if (save[k] !== undefined && save[k] !== null) G[k] = save[k];
    });

    // HP отдельно — applyCharacter перезапишет, восстановим потом
    if (save.hp !== undefined && save.hp !== null) {
      _savedHp = { hp: save.hp, maxHp: save.maxHp };
    }

    if (save.baseStats) Object.assign(G.baseStats, save.baseStats);
    if (save.stats)     Object.assign(G.stats,     save.stats);
    if (save.upg)       Object.assign(G.upg,       save.upg);
    if (save.equipped)  Object.assign(G.equipped,  save.equipped);

    if (save.bp)   G.bp   = { active: !!save.bp.active, claimed: save.bp.claimed || [] };
    if (save.prem) G.prem = { tier: save.prem.tier || null, expiresAt: save.prem.expiresAt || 0 };

    if (Array.isArray(save.inventory))                G.inventory = save.inventory;
    if (save.skills && typeof save.skills === 'object') G.skills   = save.skills;

    return save.charId || null;
  }

  // ── Снапшот G ──
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
      potionLv:  G.potionLv  || 0,
      potions:   G.potions   || 0,
      potionThreshold: G.potionThreshold || 30,
      bp:        { active: G.bp.active, claimed: G.bp.claimed.slice() },
      prem:      { tier: G.prem.tier, expiresAt: G.prem.expiresAt },
      inventory: G.inventory.slice(),
      equipped:  Object.assign({}, G.equipped),
      skills:    Object.assign({}, G.skills),
    };
  }

  // ══════════════════════════════════════════════════════
  //  Публичное API — ТОЛЬКО СЕРВЕР
  // ══════════════════════════════════════════════════════

  async function init() {
    _initData = getInitData();
    if (!_initData) {
      console.warn('[API] No initData — offline mode');
      return null;
    }
    try {
      var res = await apiFetch('/auth', {
        method: 'POST',
        body: JSON.stringify({ initData: _initData }),
      });
      _userId    = res.userId;
      _photoUrl  = res.photoUrl  || '';
      _firstName = res.firstName || '';
      console.log('[API] Auth OK userId=' + _userId + ' isNew=' + res.isNew);

      // ✅ Всегда берем с сервера
      var charId = applySave(res.save);

      // Автосохранение каждые 20 сек
      _saveTimer = setInterval(function() {
        if (_dirty) {
          save().catch(function(e) {
            console.warn('[API] Auto-save failed:', e.message);
          });
          _dirty = false;
        }
      }, 20000);

      return charId;
    } catch (e) {
      console.error('[API] Auth failed:', e.message);
      return null;
    }
  }

  // Полное сохранение: только сервер
  async function save() {
    if (!_initData) return;
    var snapshot = buildSnapshot();
    try {
      await apiFetch('/save', {
        method: 'POST',
        body: JSON.stringify(snapshot),
      });
      console.log('[API] Save OK');
    } catch (e) {
      console.error('[API] Save failed:', e.message);
      throw e;
    }
  }

  // sendBeacon при закрытии — только сервер
  function saveBeacon() {
    if (!_initData) return;
    var snapshot = buildSnapshot();
    var payload = Object.assign({}, snapshot, { _initData: _initData });
    var blob = new Blob(
      [JSON.stringify(payload)],
      { type: 'application/json' }
    );
    navigator.sendBeacon(BASE_URL + '/save/beacon', blob);
    console.log('[API] Beacon sent');
  }

  // Частичный патч сервера
  async function partial(fields) {
    if (!_initData) return;
    _dirty = false;
    try {
      await apiFetch('/save/partial', {
        method: 'POST',
        body: JSON.stringify({ fields: fields }),
      });
      console.log('[API] Partial OK');
    } catch (e) {
      console.error('[API] Partial failed:', e.message);
      throw e;
    }
  }

  function markDirty() {
    _dirty = true;
  }

  return {
    init:        init,
    save:        save,
    saveBeacon:  saveBeacon,
    partial:     partial,
    markDirty:   markDirty,
    get loaded()    { return !!_userId; },
    get userId()    { return _userId; },
    get savedHp()   { return _savedHp; },
    get photoUrl()  { return _photoUrl; },
    get firstName() { return _firstName; },
  };
})();