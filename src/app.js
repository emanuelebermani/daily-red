(function () {
  'use strict';
  const C = window.DailyRedCore;
  const $ = (id) => document.getElementById(id);
  const KEYBIT = { A: 0, B: 1, SELECT: 2, START: 3, RIGHT: 4, LEFT: 5, UP: 6, DOWN: 7, R: 8, L: 9 };
  const FRAME_MS = 1000 / 59.7275;
  const TYPE_LABEL = ['Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel', '???', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark'];
  const TYPE_COLOR = ['#9a9a78', '#b8322a', '#9580e0', '#963f96', '#cfae55', '#ac9539', '#97a51d', '#674f8a', '#a7a7c2', '#5f8f86', '#e8702a', '#5a85e6', '#62b743', '#e3b81d', '#e8487a', '#7ac9c9', '#6a3ff0', '#674e3f'];

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('dailyred:' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dailyred:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  function idbOpen() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open('daily-red', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const q = db.transaction('files').objectStore('files').get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async function idbPut(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const t = db.transaction('files', 'readwrite');
      t.objectStore('files').put(val, key);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }

  // ---------- date ----------
  function localDateKey(d) {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  const REPO = window.DAILY_RED_REPO || '';
  const today = localDateKey(new Date());
  const dayNo = C.dayNumber(today);
  const prettyDate = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('dayline').textContent = 'Challenge #' + dayNo + ' · ' + prettyDate;
  $('teamDate').textContent = '#' + dayNo;

  // ---------- leaderboard (GitHub issue that a workflow turns into a line of results.txt) ----------
  function submitUrl(rec, date) {
    const win = rec.outcome === 1;
    const title = 'Daily Red #' + rec.day + ' result: ' + rec.name + (win ? ' beat Red' : ' lost to Red');
    const body = [
      'Press **Submit new issue** to add this result to results.txt. A bot records it and closes this issue within a minute or two.',
      '',
      '```text',
      'daily-red-result',
      'date: ' + date,
      'day: ' + rec.day,
      'player: ' + rec.name,
      'outcome: ' + (win ? 'WIN' : 'LOSS'),
      'turns: ' + rec.turns,
      'standing: ' + rec.standing,
      'red_down: ' + Math.min(6, rec.redDown),
      'team: ' + (rec.team || []).join(', '),
      '```',
    ].join('\n');
    return 'https://github.com/' + REPO + '/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  }
  if (REPO) {
    $('boardLink').href = 'https://github.com/' + REPO + '/blob/main/results.txt';
    $('boardLine').hidden = false;
  }

  // ---------- record ----------
  function renderRecord() {
    const hist = store.get('history', {});
    const days = Object.keys(hist).sort();
    let wins = 0;
    days.forEach(k => { if (hist[k].outcome === 1) wins++; });
    let streak = 0;
    const d = new Date();
    if (!hist[localDateKey(d)]) d.setDate(d.getDate() - 1);
    for (;;) {
      const h = hist[localDateKey(d)];
      if (!h || h.outcome !== 1) break;
      streak++; d.setDate(d.getDate() - 1);
    }
    $('streak').textContent = streak; $('wins').textContent = wins; $('played').textContent = days.length;
  }
  renderRecord();

  // ---------- emulator ----------
  const gba = new GameBoyAdvance();
  gba.logLevel = gba.LOG_ERROR;
  gba.setLogger(function (level, msg) { if (level === gba.LOG_ERROR) console.warn('[gba]', msg); });
  gba.retrieveSavedata = function () {};
  gba.storeSavedata = function () {};
  gba.setCanvasDirect($('gba'));
  gba.setBios(window.DAILY_RED_BIOS.buffer);
  const mem32 = (a) => gba.mmu.load32(a) >>> 0;
  const mem8 = (a) => gba.mmu.load8(a) & 0xFF;
  const mem16 = (a) => gba.mmu.load16(a) & 0xFFFF;

  let rom = null, patched = null, team = null;
  let running = false, paused = false, booting = false;
  let muted = store.get('muted', false);
  let turbo = false, turboHeld = false;
  let frame = 0;
  const held = new Set();       // keyboard
  const touchHeld = new Map();  // pointerId -> key
  let scripted = null;          // keys forced during boot

  function padKeys() {
    const out = [];
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return out; }
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      if (b(0)) out.push('A'); if (b(1)) out.push('B');
      if (b(8)) out.push('SELECT'); if (b(9)) out.push('START');
      if (b(4)) out.push('L'); if (b(5)) out.push('R');
      if (b(12) || gp.axes[1] < -0.5) out.push('UP'); if (b(13) || gp.axes[1] > 0.5) out.push('DOWN');
      if (b(14) || gp.axes[0] < -0.5) out.push('LEFT'); if (b(15) || gp.axes[0] > 0.5) out.push('RIGHT');
    }
    return out;
  }
  function applyInput() {
    let m = 0x3FF;
    const keys = scripted || [...held, ...touchHeld.values(), ...padKeys()];
    keys.forEach(k => { m &= ~(1 << KEYBIT[k]); });
    gba.keypad.currentDown = m;
  }
  function setVolume() {
    gba.audio.masterVolume = (muted || booting || turbo || turboHeld) ? 0 : 1;
  }

  // ---------- screen sizing ----------
  function sizeScreen() {
    const avail = Math.min(document.querySelector('.play').clientWidth - 16, window.innerWidth - 32);
    const maxH = Math.max(220, window.innerHeight - 260);
    let w = Math.min(avail, maxH * 1.5, 960);
    if (w >= 480) w = Math.floor(w / 240) * 240;
    $('screen').style.setProperty('--sw', Math.max(200, Math.floor(w)) + 'px');
  }
  window.addEventListener('resize', sizeScreen);

  // ---------- sprites for the side panels ----------
  function drawSprite(canvas, spr) {
    canvas.width = spr.w; canvas.height = spr.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(spr.w, spr.h);
    img.data.set(spr.rgba);
    ctx.putImageData(img, 0, 0);
  }
  function typeChip(t) {
    const s = document.createElement('span');
    s.className = 'type'; s.textContent = TYPE_LABEL[t]; s.style.background = TYPE_COLOR[t];
    return s;
  }
  function renderTeam() {
    const box = $('team');
    box.textContent = '';
    team.forEach(m => {
      const el = document.createElement('div');
      el.className = 'mon';
      const cv = document.createElement('canvas');
      try { drawSprite(cv, C.monSprite(rom, m.sid)); } catch (e) { /* sprite unavailable */ }
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = m.name;
      const ty = document.createElement('div'); ty.className = 'types';
      [...new Set(m.types)].forEach(t => ty.appendChild(typeChip(t)));
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = m.natureName.charAt(0) + m.natureName.slice(1).toLowerCase() + ' nature · ' + titleCase(abilityName(m.ability));
      const ul = document.createElement('ul');
      m.moves.forEach(id => { const li = document.createElement('li'); li.textContent = rom.moves[id].name; ul.appendChild(li); });
      el.append(cv, nm, ty, meta, ul);
      box.appendChild(el);
    });
    const rr = $('redTeam');
    rr.textContent = '';
    C.redTeam(rom).forEach(r => {
      const d = document.createElement('div'); d.className = 'r';
      const cv = document.createElement('canvas');
      try { drawSprite(cv, C.monSprite(rom, r.sid)); } catch (e) { /* sprite unavailable */ }
      const s = document.createElement('span'); s.textContent = r.sp.name;
      d.title = r.moves.map(id => rom.moves[id].name).join(', ');
      d.append(cv, s);
      rr.appendChild(d);
    });
    try { drawSprite($('redpic'), C.trainerSprite(rom, 89)); } catch (e) { /* sprite unavailable */ }
  }
  function abilityName(id) { return C.decodeText(rom.u8, 0x31B6DB + id * 13, 13); }
  function titleCase(s) { return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()); }

  // ---------- ROM loading ----------
  function show(id) {
    ['romPanel', 'startPanel', 'bootPanel', 'resultPanel', 'pausePanel'].forEach(p => { $(p).hidden = p !== id; });
  }
  function otIdFor(date) { return C.makeRng('ot|' + date).u32(); }

  async function useRom(u8, fromCache) {
    const err = C.checkRom(u8);
    if (err) {
      $('romMsg').textContent = err; $('romMsg').className = 'err'; show('romPanel');
      return false;
    }
    rom = C.parseRom(u8);
    team = C.makeTeam(rom, today, { otId: otIdFor(today) });
    patched = C.patchRom(rom, {});
    renderTeam();
    if (!fromCache) { try { await idbPut('emerald', u8.buffer); } catch (e) { /* not remembered */ } }
    prepareStart();
    return true;
  }
  async function readFile(file) {
    $('romMsg').className = ''; $('romMsg').textContent = 'Reading ' + file.name + '…';
    const buf = await file.arrayBuffer();
    await useRom(new Uint8Array(buf), false);
  }
  $('romInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f && !$('romPanel').hidden) readFile(f); } });

  // ---------- start panel ----------
  let gender = store.get('gender', 0);
  function setGender(g) {
    gender = g; store.set('gender', g);
    $('boyBtn').setAttribute('aria-pressed', String(g === 0));
    $('girlBtn').setAttribute('aria-pressed', String(g === 1));
    const nameEl = $('nameInput');
    if (!store.get('name', '')) nameEl.value = g === 0 ? 'BRENDAN' : 'MAY';
  }
  $('boyBtn').addEventListener('click', () => setGender(0));
  $('girlBtn').addEventListener('click', () => setGender(1));
  $('nameInput').addEventListener('input', (e) => {
    const clean = e.target.value.toUpperCase().replace(/[^A-Z0-9 .!?]/g, '').slice(0, 7);
    if (clean !== e.target.value) e.target.value = clean;
    store.set('name', clean.trim());
  });
  function prepareStart() {
    const hist = store.get('history', {});
    const done = hist[today];
    $('startTitle').textContent = done ? (done.outcome === 1 ? 'You beat Red today' : 'Red won today') : 'Red is waiting';
    $('startNote').textContent = done
      ? 'Your result for challenge #' + dayNo + ' is saved. You can still climb back up and battle him for practice.'
      : 'Six fully evolved Pokémon at level 100, no type repeated. Red brings his original six, also at level 100.';
    $('nameInput').value = store.get('name', '') || (gender === 0 ? 'BRENDAN' : 'MAY');
    setGender(gender);
    const sub = $('startSubmit');
    sub.hidden = !(REPO && done && done.name);
    if (!sub.hidden) sub.href = submitUrl(done, today);
    show('startPanel');
  }
  $('startBtn').addEventListener('click', () => startGame());

  // ---------- boot ----------
  function player() {
    const name = ($('nameInput').value.trim() || (gender === 0 ? 'BRENDAN' : 'MAY')).slice(0, 7);
    return { name, gender, id: otIdFor(today) };
  }
  function nextTick() { return new Promise(r => setTimeout(r, 0)); }

  async function startGame() {
    try { if (gba.audio.context && gba.audio.context.state !== 'running') gba.audio.context.resume(); } catch (e) { /* audio blocked */ }
    running = false;
    show('bootPanel');
    $('bootBar').style.width = '0%';
    $('bootMsg').textContent = "Patching Red into the summit and loading today's team.";
    $('led').classList.remove('on');
    await nextTick();
    const save = C.buildSave(rom, team, player());
    gba.setRom(patched.slice().buffer);
    gba.setSavedata(save.buffer);
    booting = true; setVolume();
    gba.audio.pause(false);
    const OVERWORLD = C.CB2.overworld, MENU = C.CB2.mainMenu;
    let f = 0, ok = false;
    while (f < 4000) {
      for (let k = 0; k < 24; k++, f++) {
        const cb = mem32(C.RAM.mainCb2);
        if (cb === OVERWORLD) { ok = true; break; }
        scripted = (f % 20 < 2) ? (cb === MENU ? ['A'] : ['START']) : [];
        applyInput();
        gba.advanceFrame();
      }
      if (ok) break;
      $('bootBar').style.width = Math.min(100, f / 4.7) + '%';
      await nextTick();
    }
    scripted = null; applyInput();
    booting = false; setVolume();
    if (!ok) {
      $('bootMsg').textContent = 'The game did not reach the summit. Reload the page and try again.';
      $('bootMsg').className = 'err';
      return;
    }
    $('bootBar').style.width = '100%';
    battle = { active: false, outcome: 0, doneAt: 0, reported: false };
    show(null);
    $('tools').hidden = false;
    $('led').classList.add('on');
    running = true; paused = false;
    lastTime = performance.now(); acc = 0;
    $('gba').focus && $('gba').focus();
  }

  // ---------- battle watcher ----------
  let battle = { active: false, outcome: 0, doneAt: 0, reported: false };
  function watch() {
    const cb = mem32(C.RAM.mainCb2);
    if (cb === C.CB2.battle && !battle.active && !battle.outcome) {
      battle = { active: true, outcome: 0, doneAt: 0, reported: false };
    }
    if (battle.active && !battle.outcome) {
      const o = mem8(C.RAM.battleOutcome);
      if (o === 1 || o === 2) {
        battle.outcome = o;
        const br = C.RAM.battleResults;
        battle.turns = mem8(br + 0x13) + 1;
        battle.playerFainted = mem8(br);
        battle.redFainted = mem8(br + 1);
        battle.standing = [];
        for (let i = 0; i < 6; i++) battle.standing.push(mem16(C.RAM.playerParty + i * 100 + 0x56) > 0);
      }
    }
    if (battle.active && battle.outcome && cb === C.CB2.overworld) {
      if (!battle.doneAt) battle.doneAt = frame;
      // after a win wait for Red to vanish (his hide flag is set by the script); after a loss, a short pause
      let ready = frame - battle.doneAt > 90;
      if (battle.outcome === 1) {
        const sb1 = mem32(C.RAM.saveBlock1Ptr);
        const flag = 0x358;
        const gone = ((mem8(sb1 + 0x1270 + (flag >> 3)) >> (flag & 7)) & 1) === 1;
        if (gone && !battle.goneAt) battle.goneAt = frame;
        ready = !!battle.goneAt && frame - battle.goneAt > 75;
        if (frame - battle.doneAt > 1800) ready = true;
      }
      if (ready) { battle.active = false; reportResult(battle); battle = { active: false, outcome: 0, doneAt: 0, reported: false }; }
    }
  }

  function reportResult(b) {
    const hist = store.get('history', {});
    const official = !hist[today];
    const rec = { outcome: b.outcome, turns: b.turns, standing: b.standing.filter(Boolean).length, redDown: b.redFainted,
      day: dayNo, name: player().name, team: team.map(m => m.name) };
    if (official) { hist[today] = rec; store.set('history', hist); renderRecord(); }
    const win = b.outcome === 1;
    $('resTitle').textContent = win ? 'Red fell silent' : 'Red stands firm';
    const stats = $('resStats');
    stats.textContent = '';
    const add = (label, val) => { const d = document.createElement('div'); const s = document.createElement('strong'); s.textContent = val; d.append(s, label); stats.appendChild(d); };
    add('Turns', b.turns);
    add('Your team standing', rec.standing + '/6');
    add("Red's team down", Math.min(6, b.redFainted) + '/6');
    const squares = b.standing.map(s => (s ? '\u{1F7E9}' : '⬛')).join('');
    const redSquares = Array.from({ length: 6 }, (_, i) => (i < b.redFainted ? '\u{1F534}' : '⚪')).join('');
    const lines = ['Daily Red #' + dayNo + (official ? '' : ' (practice)'),
      win ? 'Beat Red in ' + b.turns + ' turns' : 'Lost to Red after ' + b.turns + ' turns',
      'Me  ' + squares, 'Red ' + redSquares];
    $('shareText').value = lines.join('\n');
    $('resNote').textContent = official ? 'Saved as your result for today.' : 'Practice run. Your first result today is the one that counts.';
    const sub = $('submitLink');
    sub.hidden = !(REPO && official);
    if (!sub.hidden) sub.href = submitUrl(rec, today);
    paused = true;
    show('resultPanel');
  }
  $('copyBtn').addEventListener('click', () => {
    const t = $('shareText').value;
    const done = () => { $('copyBtn').textContent = 'Copied'; setTimeout(() => { $('copyBtn').textContent = 'Copy result'; }, 1500); };
    const fallback = () => { $('shareText').focus(); $('shareText').select(); try { document.execCommand('copy'); done(); } catch (e) { /* user can copy manually */ } };
    try { navigator.clipboard.writeText(t).then(done, fallback); } catch (e) { fallback(); }
  });
  $('keepBtn').addEventListener('click', () => { show(null); paused = false; lastTime = performance.now(); });
  $('againBtn').addEventListener('click', () => startGame());
  $('restartBtn').addEventListener('click', () => startGame());
  $('resumeBtn').addEventListener('click', () => { show(null); paused = false; lastTime = performance.now(); });

  // ---------- main loop ----------
  let lastTime = performance.now(), acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!running || paused || booting) { lastTime = now; return; }
    const fast = turbo || turboHeld;
    acc += Math.min(250, now - lastTime);
    lastTime = now;
    let n = 0;
    const budget = fast ? 4 : 3;
    if (fast) { acc = 0; n = budget; } else { n = Math.floor(acc / FRAME_MS); acc -= n * FRAME_MS; if (n > budget) { n = budget; acc = 0; } }
    try {
      for (let i = 0; i < n; i++) {
        applyInput();
        gba.advanceFrame();
        frame++;
        watch();
        if (paused) break;
      }
    } catch (e) {
      console.error(e);
      running = false;
      $('bootMsg').textContent = 'The emulator stopped: ' + e.message + '. Press Restart to try again.';
      show('bootPanel');
    }
  }
  requestAnimationFrame(loop);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (running) gba.audio.pause(true); }
    else if (running) { gba.audio.pause(false); lastTime = performance.now(); }
  });

  // ---------- controls ----------
  const KEYMAP = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', z: 'A', Z: 'A', x: 'B', X: 'B', Enter: 'START', Shift: 'SELECT', Backspace: 'SELECT', a: 'L', A: 'L', s: 'R', S: 'R' };
  function inField(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'); }
  window.addEventListener('keydown', (e) => {
    if (inField(e) || !running) return;
    if (e.code === 'Space') { turboHeld = true; setVolume(); e.preventDefault(); return; }
    const k = KEYMAP[e.key];
    if (k) { held.add(k); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { turboHeld = false; setVolume(); if (running && !inField(e)) e.preventDefault(); return; }
    const k = KEYMAP[e.key];
    if (k) held.delete(k);
  });
  window.addEventListener('blur', () => { held.clear(); turboHeld = false; setVolume(); });

  document.querySelectorAll('.tools button').forEach(btn => btn.addEventListener('click', () => btn.blur()));
  $('soundBtn').addEventListener('click', () => {
    muted = !muted; store.set('muted', muted); setVolume();
    $('soundBtn').textContent = muted ? 'Sound off' : 'Sound on';
    $('soundBtn').setAttribute('aria-pressed', String(!muted));
  });
  $('soundBtn').textContent = muted ? 'Sound off' : 'Sound on';
  $('soundBtn').setAttribute('aria-pressed', String(!muted));
  $('fastBtn').addEventListener('click', () => {
    turbo = !turbo; setVolume();
    $('fastBtn').setAttribute('aria-pressed', String(turbo));
  });

  // touch pad
  const pad = $('pad');
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  let padOn = store.get('pad', coarse);
  function setPad(v) { padOn = v; store.set('pad', v); pad.classList.toggle('show', v); $('padBtn').setAttribute('aria-pressed', String(v)); $('keysHint').hidden = v && coarse; sizeScreen(); }
  $('padBtn').addEventListener('click', () => setPad(!padOn));
  setPad(padOn);
  function dirFromPoint(el, x, y) {
    const r = el.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'RIGHT' : 'LEFT') : (dy > 0 ? 'DOWN' : 'UP');
  }
  const dpad = $('dpad');
  function dpadMove(e) {
    const k = dirFromPoint(dpad, e.clientX, e.clientY);
    if (k) touchHeld.set(e.pointerId, k); else touchHeld.delete(e.pointerId);
  }
  dpad.addEventListener('pointerdown', (e) => { e.preventDefault(); dpad.setPointerCapture(e.pointerId); dpadMove(e); });
  dpad.addEventListener('pointermove', (e) => { if (touchHeld.has(e.pointerId)) dpadMove(e); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => dpad.addEventListener(ev, (e) => touchHeld.delete(e.pointerId)));
  pad.querySelectorAll('[data-key]').forEach(btn => {
    const key = btn.dataset.key;
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); touchHeld.set(e.pointerId, key); btn.classList.add('held'); });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, (e) => { touchHeld.delete(e.pointerId); btn.classList.remove('held'); }));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // ---------- start up ----------
  sizeScreen();
  (async () => {
    let cached = null;
    try { cached = await idbGet('emerald'); } catch (e) { /* no stored ROM */ }
    if (cached) {
      const ok = await useRom(new Uint8Array(cached), true);
      if (ok) return;
    }
    show('romPanel');
  })();

  // test hook for automated checks
  window.__dailyRed = { gba, get battle() { return battle; }, get team() { return team; }, get running() { return running; }, press(keys) { scripted = keys; applyInput(); }, release() { scripted = null; applyInput(); },
    setPatch(opts) { patched = C.patchRom(rom, opts || {}); },
    run(n, keysAt) { for (let i = 0; i < n && !paused; i++) { scripted = keysAt ? keysAt(frame, mem32(C.RAM.mainCb2)) : null; applyInput(); gba.advanceFrame(); frame++; watch(); } scripted = null; applyInput(); return { frame, paused, cb: mem32(C.RAM.mainCb2).toString(16) }; } };
})();
