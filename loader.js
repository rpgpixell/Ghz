/*
  ══════════════════════════════════════════════════════
  loader.js — Экран загрузки
  Подключается последним (после ui.js).

  Порядок:
  1. Telegram SDK ready + expand
  2. API.init() — auth + load save (прогресс-бар)
  3a. Новый игрок → показать charSelect
  3b. Есть сейв   → восстановить персонажа → startGame()
  ══════════════════════════════════════════════════════
*/

(function() {

  // ── DOM экрана загрузки (создаём программно, не в HTML) ──
  function createLoaderDOM() {
    var el = document.createElement('div');
    el.id  = 'loaderScreen';
    el.innerHTML = [
      '<div class="ld-bg"></div>',
      '<div class="ld-content">',
      '  <div class="ld-logo">',
      '    <div class="ld-title">PIXEL RUNNER</div>',
      '    <div class="ld-subtitle">RPG</div>',
      '  </div>',
      '  <div class="ld-bar-wrap">',
      '    <div class="ld-bar-track">',
      '      <div class="ld-bar-fill" id="ldBarFill"></div>',
      '    </div>',
      '    <div class="ld-bar-label" id="ldBarLabel">Подключение...</div>',
      '  </div>',
      '  <div class="ld-dots" id="ldDots">',
      '    <span></span><span></span><span></span>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(el);
    return el;
  }

  // ── CSS для экрана загрузки ──
  function injectLoaderCSS() {
    var style = document.createElement('style');
    style.textContent = [
      '#loaderScreen {',
      '  position: fixed; inset: 0; z-index: 9999;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: #0d0d1a;',
      '  transition: opacity 0.5s ease;',
      '}',
      '.ld-bg {',
      '  position: absolute; inset: 0;',
      '  background: radial-gradient(ellipse at 50% 40%, rgba(80,40,180,0.25) 0%, transparent 70%);',
      '  pointer-events: none;',
      '}',
      '.ld-content {',
      '  position: relative; z-index: 1;',
      '  display: flex; flex-direction: column; align-items: center;',
      '  width: 80%; max-width: 300px; gap: 28px;',
      '}',
      '.ld-logo { text-align: center; }',
      '.ld-title {',
      '  font-family: "Courier New", monospace;',
      '  font-size: 28px; font-weight: bold; letter-spacing: 4px;',
      '  color: #f5c542;',
      '  text-shadow: 0 0 20px rgba(245,197,66,0.5);',
      '  image-rendering: pixelated;',
      '}',
      '.ld-subtitle {',
      '  font-family: "Courier New", monospace;',
      '  font-size: 14px; letter-spacing: 8px;',
      '  color: #a78bfa; margin-top: 4px;',
      '}',
      '.ld-bar-wrap { width: 100%; }',
      '.ld-bar-track {',
      '  width: 100%; height: 4px;',
      '  background: rgba(255,255,255,0.08);',
      '  border-radius: 2px; overflow: hidden;',
      '}',
      '.ld-bar-fill {',
      '  height: 100%; width: 0%;',
      '  background: linear-gradient(90deg, #a78bfa, #f5c542);',
      '  border-radius: 2px;',
      '  transition: width 0.4s ease;',
      '}',
      '.ld-bar-label {',
      '  font-family: "Courier New", monospace;',
      '  font-size: 11px; color: #556;',
      '  text-align: center; margin-top: 8px;',
      '  letter-spacing: 1px;',
      '}',
      '.ld-dots {',
      '  display: flex; gap: 8px; justify-content: center;',
      '}',
      '.ld-dots span {',
      '  width: 6px; height: 6px; border-radius: 50%;',
      '  background: #2a2a5a;',
      '  animation: ldPulse 1.2s ease-in-out infinite;',
      '}',
      '.ld-dots span:nth-child(2) { animation-delay: 0.2s; }',
      '.ld-dots span:nth-child(3) { animation-delay: 0.4s; }',
      '@keyframes ldPulse {',
      '  0%,100% { background: #2a2a5a; transform: scale(1); }',
      '  50% { background: #a78bfa; transform: scale(1.4); }',
      '}',
      '#loaderScreen.ld-fade {',
      '  opacity: 0; pointer-events: none;',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── Обновление прогресс-бара ──
  function setProgress(pct, label) {
    var fill  = document.getElementById('ldBarFill');
    var lbl   = document.getElementById('ldBarLabel');
    if (fill)  fill.style.width  = pct + '%';
    if (lbl)   lbl.textContent   = label;
  }

  // ── Скрыть экран загрузки ──
  function hideLoader() {
    var el = document.getElementById('loaderScreen');
    if (!el) return;
    el.classList.add('ld-fade');
    setTimeout(function() { el.remove(); }, 550);
  }

  // ── Восстановить персонажа из charId и запустить игру ──
  function restoreAndStart(charId) {
    var ch = charId && typeof CHARS !== 'undefined' ? CHARS[charId] : null;
    if (!ch) {
      // Нет сейва или неизвестный персонаж — показать charSelect
      showCharSelect();
      return;
    }

    // Применяем персонажа (аналог confirmChar без скрытия charSelect)
    G_CHAR = ch;

    // applyCharacter устанавливает спрайты и baseStats из шаблона,
    // но мы уже загрузили baseStats из сейва — сохраняем их
    var savedBaseStats = JSON.parse(JSON.stringify(G.baseStats));

    if (typeof spriteRun !== 'undefined') {
      spriteRun.src  = ch.runSrc;
      spriteAtk.src  = ch.atkSrc;
      spriteIdle.src = ch.idleSrc;
    }
    window.RUN_FRAMES_CUR  = ch.runFrames;
    window.RUN_FW_CUR      = ch.runFW;
    window.ATK_FRAMES_CUR  = ch.atkFrames;
    window.ATK_FW_CUR      = ch.atkFW;
    window.IDLE_FRAMES_CUR = ch.idleFrames;
    window.IDLE_FW_CUR     = ch.idleFW;

    // Восстанавливаем baseStats из сейва (не из шаблона персонажа)
    G.baseStats = savedBaseStats;

    // Пересчитываем stats от загруженных baseStats
    if (typeof recalcStats === 'function') recalcStats();

    // Скрываем charSelect на случай если он видим
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');

    // Запускаем игру
    if (typeof startGame === 'function') startGame();
  }

  function showCharSelect() {
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.remove('hidden');
    if (typeof initCharSelectSprites === 'function') initCharSelectSprites();
    if (typeof initCsParticles       === 'function') initCsParticles();
  }

  // ══════════════════════════════════════════════
  //  MAIN — запускается после загрузки страницы
  // ══════════════════════════════════════════════
  window.addEventListener('load', function() {
    injectLoaderCSS();
    var loaderEl = createLoaderDOM();

    // Сразу скрыть charSelect пока грузимся
    var cs = document.getElementById('charSelect');
    if (cs) cs.classList.add('hidden');

    setProgress(10, 'Инициализация...');

    // Шаг 1: Telegram SDK
    var tgReady = new Promise(function(resolve) {
      if (window.Telegram && window.Telegram.WebApp) {
        Telegram.WebApp.ready();
        Telegram.WebApp.expand();
        resolve();
      } else {
        // Ждём немного на случай асинхронной загрузки SDK
        setTimeout(resolve, 300);
      }
    });

    // Шаг 2: Загрузка спрайтов (ждём render.js canvas init)
    var spritesReady = new Promise(function(resolve) {
      // spriteRun и spriteAtk объявлены в render.js
      // Ждём их появления
      var attempts = 0;
      var check = setInterval(function() {
        attempts++;
        if (
          (typeof spriteRun !== 'undefined' && typeof spriteAtk !== 'undefined') ||
          attempts > 30
        ) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });

    // Шаг 3: Auth + load
    tgReady
      .then(function() {
        setProgress(25, 'Авторизация...');
        return spritesReady;
      })
      .then(function() {
        setProgress(40, 'Подключение к серверу...');
        return API.init();
      })
      .then(function(result) {
        setProgress(80, 'Загрузка данных...');

        // Небольшая пауза чтобы прогресс-бар успел отрисоваться
        return new Promise(function(resolve) {
          setTimeout(function() { resolve(result); }, 400);
        });
      })
      .then(function(result) {
        setProgress(100, 'Готово!');

        setTimeout(function() {
          hideLoader();

          if (result.isNew || !result.charId) {
            // Новый игрок — показываем выбор персонажа
            showCharSelect();
          } else {
            // Есть сейв — восстанавливаем и запускаем
            restoreAndStart(result.charId);
          }
        }, 300);
      })
      .catch(function(err) {
        console.error('[Loader] Fatal error:', err);
        setProgress(100, 'Ошибка загрузки — запуск офлайн');
        setTimeout(function() {
          hideLoader();
          showCharSelect();
        }, 1500);
      });
  });

})();
