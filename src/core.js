/* Daily Red core: reads Pokemon Emerald (BPEE) data, builds the daily team,
   writes a save file and patches Red's encounter into the ROM image in memory.
   Runs in the browser and in Node (for testing). */
(function (root) {
  'use strict';

  // ---------- ROM offsets (Pokemon Emerald, USA/Europe) ----------
  const OFF = {
    speciesNames: 0x3185C8, moveNames: 0x31977C, abilityNames: 0x31B6DB,
    speciesInfo: 0x3203CC, battleMoves: 0x31C898, levelUp: 0x32937C,
    tmhmLearn: 0x31E898, tmhmMoves: 0x616040, tutorMoves: 0x61500C, tutorLearn: 0x615048,
    eggMoves: 0x32ADD8, evolution: 0x32531C, natDex: 0x31DC82, expTables: 0x31F72C,
    dexEntries: 0x56B5B0, typeChart: 0x31ACE8, trainers: 0x310030,
    trainerClassNames: 0x30FCD4, regionMapEntries: 0x5A147C, mapGroups: 0x486578,
    free: 0xF00000,
  };
  const RAM = {
    mainCb2: 0x030022C4, battleOutcome: 0x0202433A, battleResults: 0x03005D10,
    playerParty: 0x020244EC, playerPartyCount: 0x020244E9, enemyParty: 0x02024744,
    saveBlock1Ptr: 0x03005D8C,
  };
  const CB2 = {
    overworld: 0x08085E5D, battle: 0x08038421, mainMenu: 0x0802F6B1,
  };

  // ---------- Text ----------
  const DEC = {};
  const ENC = {};
  (function buildCharset() {
    const put = (code, ch) => { DEC[code] = ch; if (!(ch in ENC)) ENC[ch] = code; };
    put(0x00, ' ');
    for (let i = 0; i < 10; i++) put(0xA1 + i, String(i));
    for (let i = 0; i < 26; i++) { put(0xBB + i, String.fromCharCode(65 + i)); put(0xD5 + i, String.fromCharCode(97 + i)); }
    put(0xAB, '!'); put(0xAC, '?'); put(0xAD, '.'); put(0xAE, '-'); put(0xB0, '…');
    put(0xB1, '“'); put(0xB2, '”'); put(0xB3, '‘'); put(0xB4, '\''); put(0xB4, '’');
    put(0xB5, '♂'); put(0xB6, '♀'); put(0xB8, ','); put(0xBA, '/'); put(0x1B, 'é');
    put(0xF0, ':'); put(0x53, 'PK'); put(0x54, 'MN');
  })();
  function decodeText(u8, off, max) {
    let s = '';
    for (let i = 0; i < (max || 64); i++) {
      const c = u8[off + i];
      if (c === 0xFF) break;
      s += (c in DEC) ? DEC[c] : '?';
    }
    return s;
  }
  function encodeText(str, len) {
    const out = [];
    for (const ch of str) {
      if (ch in ENC) out.push(ENC[ch]);
      else if (ch.toUpperCase() in ENC) out.push(ENC[ch.toUpperCase()]);
    }
    out.push(0xFF);
    if (len) { while (out.length < len) out.push(0xFF); out.length = len; }
    return out;
  }

  // ---------- Little helpers ----------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const w16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };
  const w32 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; };
  const ptr = (b, o) => u32(b, o) - 0x08000000;

  function hashString(str) {
    let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h1 ^ h2) >>> 0;
  }
  function makeRng(seedStr) {
    let a = hashString(seedStr);
    const next = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, int: (n) => Math.floor(next() * n), u32: () => (Math.floor(next() * 65536) << 16 | Math.floor(next() * 65536)) >>> 0 };
  }

  // ---------- ROM parsing ----------
  const TYPE_NAMES = ['NORMAL', 'FIGHT', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL', '???', 'FIRE', 'WATER', 'GRASS', 'ELECTR', 'PSYCHC', 'ICE', 'DRAGON', 'DARK'];

  function checkRom(u8) {
    if (!u8 || u8.length < 0x1000000) return 'This file is too small to be a Pokémon Emerald ROM.';
    const code = String.fromCharCode(u8[0xAC], u8[0xAD], u8[0xAE], u8[0xAF]);
    if (code !== 'BPEE') return 'This ROM is game code ' + code + '. Daily Red needs Pokémon Emerald (USA/Europe, code BPEE).';
    if (decodeText(u8, OFF.speciesNames + 11, 11) !== 'BULBASAUR' || decodeText(u8, OFF.moveNames + 13, 13) !== 'POUND')
      return 'This Emerald ROM looks modified, so its data is not where Daily Red expects it.';
    return null;
  }

  function parseRom(u8) {
    const err = checkRom(u8);
    if (err) throw new Error(err);
    const NUM_SPECIES = 412, NUM_MOVES = 355;
    const moves = [];
    for (let i = 0; i < NUM_MOVES; i++) {
      const o = OFF.battleMoves + i * 12;
      moves.push({
        id: i, name: decodeText(u8, OFF.moveNames + i * 13, 13),
        effect: u8[o], power: u8[o + 1], type: u8[o + 2], acc: u8[o + 3], pp: u8[o + 4],
        chance: u8[o + 5], target: u8[o + 6], priority: (u8[o + 7] << 24) >> 24, flags: u8[o + 8],
      });
    }
    const moveByName = {};
    moves.forEach(m => { moveByName[m.name] = m.id; });

    const tmMoves = [], tutorMoves = [];
    for (let i = 0; i < 58; i++) tmMoves.push(u16(u8, OFF.tmhmMoves + i * 2));
    for (let i = 0; i < 30; i++) tutorMoves.push(u16(u8, OFF.tutorMoves + i * 2));

    const species = [];
    const natToSpecies = {};
    const prevo = {};
    for (let s = 0; s < NUM_SPECIES; s++) {
      const o = OFF.speciesInfo + s * 28;
      const nat = s === 0 ? 0 : u16(u8, OFF.natDex + (s - 1) * 2);
      const sp = {
        id: s, nat, name: decodeText(u8, OFF.speciesNames + s * 11, 11),
        base: { hp: u8[o], atk: u8[o + 1], def: u8[o + 2], spe: u8[o + 3], spa: u8[o + 4], spd: u8[o + 5] },
        types: [u8[o + 6], u8[o + 7]], genderRatio: u8[o + 16], friendship: u8[o + 18], growth: u8[o + 19],
        abilities: [u8[o + 22], u8[o + 23]],
      };
      // level-up learnset
      const lu = [];
      if (s > 0) {
        let p = ptr(u8, OFF.levelUp + s * 4);
        for (let k = 0; k < 40; k++, p += 2) { const v = u16(u8, p); if (v === 0xFFFF) break; lu.push({ lvl: v >> 9, move: v & 0x1FF }); }
      }
      sp.levelUp = lu;
      const tmLo = u32(u8, OFF.tmhmLearn + s * 8), tmHi = u32(u8, OFF.tmhmLearn + s * 8 + 4);
      sp.tm = [];
      for (let i = 0; i < 58; i++) if (i < 32 ? (tmLo >>> i) & 1 : (tmHi >>> (i - 32)) & 1) sp.tm.push(tmMoves[i]);
      const tut = u32(u8, OFF.tutorLearn + s * 4);
      sp.tutor = [];
      for (let i = 0; i < 30; i++) if ((tut >>> i) & 1) sp.tutor.push(tutorMoves[i]);
      sp.egg = [];
      if (nat >= 1 && nat <= 386) { natToSpecies[nat] = s; sp.weight = u16(u8, OFF.dexEntries + nat * 32 + 14); }
      for (let e = 0; e < 5; e++) {
        const eo = OFF.evolution + s * 40 + e * 8;
        const method = u16(u8, eo), target = u16(u8, eo + 4);
        if (method && target && target < NUM_SPECIES) { sp.evolves = true; if (!(target in prevo)) prevo[target] = s; }
      }
      species.push(sp);
    }
    // egg moves
    let p = OFF.eggMoves, cur = null;
    for (let k = 0; k < 5000; k++, p += 2) {
      const v = u16(u8, p);
      if (v === 0xFFFF) break;
      if (v > 20000) cur = species[v - 20000]; else if (cur) cur.egg.push(v);
    }
    // type chart
    const typeChart = {};
    for (let q = OFF.typeChart; ; q += 3) {
      const a = u8[q];
      if (a === 0xFF) break;
      if (a === 0xFE) continue;
      typeChart[a * 32 + u8[q + 1]] = u8[q + 2] / 10;
    }
    const expAt100 = (g) => u32(u8, OFF.expTables + (g * 101 + 100) * 4);
    return { u8, moves, moveByName, species, natToSpecies, prevo, typeChart, expAt100, tmMoves, tutorMoves };
  }

  function typeMult(rom, atkType, defTypes) {
    let m = 1;
    const t1 = defTypes[0], t2 = defTypes[1];
    const a = rom.typeChart[atkType * 32 + t1];
    if (a !== undefined) m *= a;
    if (t2 !== t1) { const b = rom.typeChart[atkType * 32 + t2]; if (b !== undefined) m *= b; }
    return m;
  }

  // ---------- Learnable moves ----------
  const STRUGGLE = 165, SKETCH = 166;
  function learnableMoves(rom, sid) {
    const set = new Set();
    if (sid === rom.natToSpecies[235]) { // Smeargle can Sketch anything
      for (let m = 1; m < rom.moves.length; m++) if (m !== STRUGGLE && m !== SKETCH) set.add(m);
      return [...set];
    }
    let s = sid, root = sid, guard = 0;
    while (s !== undefined && guard++ < 5) {
      const sp = rom.species[s];
      sp.levelUp.forEach(l => set.add(l.move));
      sp.tm.forEach(m => set.add(m));
      sp.tutor.forEach(m => set.add(m));
      root = s;
      s = rom.prevo[s];
    }
    rom.species[root].egg.forEach(m => set.add(m));
    set.delete(0); set.delete(STRUGGLE);
    return [...set].filter(m => m > 0 && m < rom.moves.length);
  }

  // ---------- Stats ----------
  const NATURE_NAMES = ['HARDY', 'LONELY', 'BRAVE', 'ADAMANT', 'NAUGHTY', 'BOLD', 'DOCILE', 'RELAXED', 'IMPISH', 'LAX', 'TIMID', 'HASTY', 'SERIOUS', 'JOLLY', 'NAIVE', 'MODEST', 'MILD', 'QUIET', 'BASHFUL', 'RASH', 'CALM', 'GENTLE', 'SASSY', 'CAREFUL', 'QUIRKY'];
  const STAT_KEYS = ['atk', 'def', 'spe', 'spa', 'spd'];
  function calcStats(sp, level, ivs, evs, nature) {
    const b = sp.base;
    const st = {};
    st.hp = sp.base.hp === 1 ? 1 : Math.floor((2 * b.hp + ivs.hp + Math.floor(evs.hp / 4)) * level / 100) + level + 10;
    const inc = Math.floor(nature / 5), dec = nature % 5;
    STAT_KEYS.forEach((k, i) => {
      let v = Math.floor((2 * b[k] + ivs[k] + Math.floor(evs[k] / 4)) * level / 100) + 5;
      if (inc !== dec) { if (i === inc) v = Math.floor(v * 110 / 100); if (i === dec) v = Math.floor(v * 90 / 100); }
      st[k] = v;
    });
    return st;
  }
  const IV31 = { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 };
  const EV0 = { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };

  // ---------- Red ----------
  const RED_TEAM = [
    { species: 'PIKACHU', lvl: 100, moves: ['CHARM', 'QUICK ATTACK', 'THUNDERBOLT', 'THUNDER'] },
    { species: 'ESPEON', lvl: 100, moves: ['MUD-SLAP', 'REFLECT', 'SWIFT', 'PSYCHIC'] },
    { species: 'SNORLAX', lvl: 100, moves: ['AMNESIA', 'SNORE', 'REST', 'BODY SLAM'] },
    { species: 'VENUSAUR', lvl: 100, moves: ['SUNNY DAY', 'GIGA DRAIN', 'SYNTHESIS', 'SOLARBEAM'] },
    { species: 'CHARIZARD', lvl: 100, moves: ['FLAMETHROWER', 'WING ATTACK', 'SLASH', 'FIRE SPIN'] },
    { species: 'BLASTOISE', lvl: 100, moves: ['RAIN DANCE', 'SURF', 'BLIZZARD', 'WHIRLPOOL'] },
  ];
  function speciesByName(rom, name) { return rom.species.findIndex(s => s.name === name); }
  function redTeam(rom, levelOverride) {
    return RED_TEAM.map(r => {
      const sid = speciesByName(rom, r.species);
      const sp = rom.species[sid];
      const lvl = levelOverride || r.lvl;
      return { sid, sp, lvl, stats: calcStats(sp, lvl, IV31, EV0, 0), types: sp.types, moves: r.moves.map(n => rom.moveByName[n]) };
    });
  }

  // ---------- Best moveset picker ----------
  const PHYS = (t) => t < 10;
  const E = { // Gen 3 move effect ids used by the picker
    SLEEP: 1, ABSORB: 3, EXPLOSION: 7, DREAM_EATER: 8, ATTACK_UP: 10, DEFENSE_UP: 11, SPEED_UP: 12, SPATK_UP: 13, SPDEF_UP: 14,
    EVASION_UP: 16, ATTACK_DOWN: 18, ACCURACY_DOWN: 23, HAZE: 25, BIDE: 26, RAMPAGE: 27, ROAR: 28, MULTI_HIT: 29,
    RESTORE_HP: 32, TOXIC: 33, LIGHT_SCREEN: 35, REST: 37, OHKO: 38, RAZOR_WIND: 39, SUPER_FANG: 40, DRAGON_RAGE: 41,
    TRAP: 42, HIGH_CRIT: 43, DOUBLE_HIT: 44, RECOIL_IF_MISS: 45, RECOIL: 48, CONFUSE: 49, ATTACK_UP_2: 50,
    DEFENSE_UP_2: 51, SPEED_UP_2: 52, SPATK_UP_2: 53, SPDEF_UP_2: 54, TRANSFORM: 57, ATTACK_DOWN_2: 58, DEFENSE_DOWN_2: 59,
    SPEED_DOWN_2: 60, SPDEF_DOWN_2: 62, REFLECT: 65, POISON: 66, PARALYZE: 67, SKY_ATTACK: 75, TWINEEDLE: 77,
    SUBSTITUTE: 79, RECHARGE: 80, RAGE: 81, METRONOME: 83, LEECH_SEED: 84, SPLASH: 85, LEVEL_DAMAGE: 87, PSYWAVE: 88,
    COUNTER: 89, ENCORE: 90, SNORE: 92, DESTINY_BOND: 98, FLAIL: 99, FALSE_SWIPE: 101, TRIPLE_KICK: 104, CURSE: 109,
    PROTECT: 111, SPIKES: 112, PERISH_SONG: 114, ROLLOUT: 117, SWAGGER: 118, FURY_CUTTER: 119, RETURN: 121, PRESENT: 122,
    FRUSTRATION: 123, MAGNITUDE: 126, SONICBOOM: 130, MORNING_SUN: 132, SYNTHESIS: 133, MOONLIGHT: 134, HIDDEN_POWER: 135,
    BELLY_DRUM: 142, MIRROR_COAT: 144, SKULL_BASH: 145, FUTURE_SIGHT: 148, SOLARBEAM: 151, BEAT_UP: 154, SEMI_INVULNERABLE: 155,
    SOFTBOILED: 157, FAKE_OUT: 158, UPROAR: 159, SPIT_UP: 161, WILL_O_WISP: 167, MEMENTO: 168, FACADE: 169, FOCUS_PUNCH: 170,
    SMELLINGSALT: 171, TAUNT: 175, WISH: 179, INGRAIN: 181, SUPERPOWER: 182, REVENGE: 185, YAWN: 187, ENDEAVOR: 189,
    ERUPTION: 190, LOW_KICK: 196, DOUBLE_EDGE: 198, WEATHER_BALL: 203, OVERHEAT: 204, COSMIC_POWER: 206, BULK_UP: 208,
    CALM_MIND: 211, DRAGON_DANCE: 212,
  };
  const ABIL = { HUGE_POWER: 37, PURE_POWER: 74, HUSTLE: 55, COMPOUND_EYES: 14, LEVITATE: 26, THICK_FAT: 47 };

  function lowKickPower(w) { return w < 100 ? 20 : w < 250 ? 40 : w < 500 ? 60 : w < 1000 ? 80 : w < 2000 ? 100 : 120; }

  // Expected fraction of the target's HP removed by one use (accuracy and reliability included).
  function attackScore(rom, mon, mv, tgt) {
    const e = mv.effect;
    let type = mv.type;
    if (e === E.HIDDEN_POWER) type = 17; // all IVs 31 -> Dark, power 70
    const eff = typeMult(rom, type, tgt.types);
    if (eff === 0) return 0;
    let acc = mv.acc === 0 ? 100 : mv.acc;
    if (mon.ability === ABIL.COMPOUND_EYES) acc = Math.min(100, acc * 1.3);
    if (mon.ability === ABIL.HUSTLE && PHYS(type)) acc *= 0.8;
    acc /= 100;
    const hp = tgt.stats.hp;
    // fixed damage moves
    if (e === E.LEVEL_DAMAGE) return Math.min(1.1, 100 / hp) * acc;
    if (e === E.PSYWAVE) return Math.min(1.1, 100 / hp) * acc * 0.9;
    if (e === E.SUPER_FANG) return 0.5 * acc * 0.9;
    if (e === E.DRAGON_RAGE) return Math.min(1, 40 / hp) * acc;
    if (e === E.SONICBOOM) return Math.min(1, 20 / hp) * acc;
    if (e === E.OHKO) return Math.max(0, Math.min(1, (30 + 100 - tgt.lvl) / 100)) * 0.65;
    if (e === E.COUNTER || e === E.MIRROR_COAT) return 0.3;
    if (e === E.ENDEAVOR || e === E.BIDE) return 0.15;
    if (e === E.DREAM_EATER || e === E.SNORE || e === E.SPIT_UP || e === E.BEAT_UP) return 0;
    let power = mv.power;
    let mult = 1;
    switch (e) {
      case E.RETURN: power = 102; break;
      case E.FRUSTRATION: power = 1; break;
      case E.FLAIL: power = 30; break;
      case E.MAGNITUDE: power = 71; break;
      case E.PRESENT: power = 30; break;
      case E.HIDDEN_POWER: power = 70; break;
      case E.LOW_KICK: power = lowKickPower(tgt.sp.weight || 500); break;
      case E.ERUPTION: power = 150; mult = 0.8; break;
      case E.TRIPLE_KICK: power = 45; break;
      case E.MULTI_HIT: power *= 3; break;
      case E.DOUBLE_HIT: case E.TWINEEDLE: power *= 2; break;
      case E.EXPLOSION: power *= 2; mult = 0.12; break;
      case E.RAZOR_WIND: case E.SKY_ATTACK: case E.SKULL_BASH: case E.SOLARBEAM: mult = 0.5; break;
      case E.RECHARGE: mult = 0.6; break;
      case E.SEMI_INVULNERABLE: mult = 0.85; break;
      case E.RAMPAGE: case E.OVERHEAT: mult = 0.85; break;
      case E.SUPERPOWER: case E.RECOIL: mult = 0.92; break;
      case E.DOUBLE_EDGE: mult = 0.88; break;
      case E.RECOIL_IF_MISS: mult = 0.9; break;
      case E.FOCUS_PUNCH: mult = 0.45; break;
      case E.FAKE_OUT: mult = 0.25; break;
      case E.FUTURE_SIGHT: mult = 0.6; break;
      case E.ROLLOUT: case E.FURY_CUTTER: mult = 0.7; break;
      case E.RAGE: mult = 0.8; break;
      case E.WEATHER_BALL: power = 60; break;
      case E.REVENGE: mult = 1.3; break;
      case E.ABSORB: mult = 1.15; break;
      case E.TRAP: mult = 1.08; break;
      case E.HIGH_CRIT: mult = 1.08; break;
      case E.FALSE_SWIPE: mult = 0.9; break;
      case E.UPROAR: mult = 0.9; break;
      default: break;
    }
    if (power <= 1) return 0;
    if (mv.chance > 0 && mv.chance < 100) mult *= 1 + mv.chance / 100 * 0.15;
    if (mv.priority > 0) mult *= 1.05;
    const phys = PHYS(type);
    let A = phys ? mon.stats.atk : mon.stats.spa;
    const D = phys ? tgt.stats.def : tgt.stats.spd;
    if (phys && (mon.ability === ABIL.HUGE_POWER || mon.ability === ABIL.PURE_POWER)) A *= 2;
    if (phys && mon.ability === ABIL.HUSTLE) A *= 1.5;
    let dmg = Math.floor(Math.floor(Math.floor(2 * mon.lvl / 5 + 2) * power * A / D) / 50) + 2;
    if (mon.types[0] === type || mon.types[1] === type) dmg *= 1.5;
    dmg *= eff * 0.925;
    if (tgt.ability === ABIL.THICK_FAT && (type === 10 || type === 15)) dmg *= 0.5;
    return (dmg / hp) * acc * mult;
  }

  // Value of a non damaging move, in "fractions of an enemy KO".
  function statusValue(mv, physDmg, specDmg, mon) {
    const acc = (mv.acc === 0 ? 100 : mv.acc) / 100;
    switch (mv.effect) {
      case E.SLEEP: return { cat: 'sleep', v: 1.05 * acc };
      case E.YAWN: return { cat: 'sleep', v: 0.35 };
      case E.TOXIC: return { cat: 'status', v: 0.45 * acc };
      case E.POISON: return { cat: 'status', v: 0.2 * acc };
      case E.WILL_O_WISP: return { cat: 'status', v: 0.35 * acc };
      case E.PARALYZE: return { cat: 'status', v: 0.4 * acc };
      case E.CONFUSE: return { cat: 'status2', v: 0.15 * acc };
      case E.SWAGGER: return { cat: 'status2', v: 0.12 * acc };
      case E.LEECH_SEED: return { cat: 'seed', v: 0.25 * acc };
      case E.ATTACK_UP_2: return { cat: 'setup', v: (physDmg > 0 ? 0.1 + 0.3 * physDmg : 0) };
      case E.BELLY_DRUM: return { cat: 'setup', v: (physDmg > 0 ? 0.1 + 0.3 * physDmg : 0) };
      case E.DRAGON_DANCE: return { cat: 'setup', v: (physDmg > 0 ? 0.12 + 0.34 * physDmg : 0) };
      case E.BULK_UP: return { cat: 'setup', v: (physDmg > 0 ? 0.12 + 0.25 * physDmg : 0) };
      case E.CURSE: return { cat: 'setup', v: mon.types.includes(7) ? 0 : (physDmg > 0 ? 0.08 + 0.18 * physDmg : 0) };
      case E.ATTACK_UP: return { cat: 'setup', v: (physDmg > 0 ? 0.04 + 0.12 * physDmg : 0) };
      case E.CALM_MIND: return { cat: 'setup', v: (specDmg > 0 ? 0.12 + 0.28 * specDmg : 0) };
      case E.SPATK_UP_2: return { cat: 'setup', v: (specDmg > 0 ? 0.1 + 0.3 * specDmg : 0) };
      case E.SPATK_UP: return { cat: 'setup', v: (specDmg > 0 ? 0.04 + 0.12 * specDmg : 0) };
      case E.SPEED_UP_2: return { cat: 'setup2', v: (physDmg + specDmg > 0 ? 0.04 + 0.05 * (physDmg + specDmg) : 0) };
      case E.RESTORE_HP: case E.SOFTBOILED: return { cat: 'heal', v: 0.4 };
      case E.MORNING_SUN: case E.SYNTHESIS: case E.MOONLIGHT: return { cat: 'heal', v: 0.3 };
      case E.WISH: return { cat: 'heal', v: 0.25 };
      case E.REST: return { cat: 'heal', v: 0.15 };
      case E.INGRAIN: return { cat: 'heal', v: 0.12 };
      case E.SUBSTITUTE: return { cat: 'sub', v: 0.18 };
      case E.SPIKES: return { cat: 'hazard', v: 0.3 };
      case E.TRANSFORM: return { cat: 'transform', v: 0.6 };
      case E.DESTINY_BOND: return { cat: 'misc', v: 0.25 };
      case E.REFLECT: case E.LIGHT_SCREEN: return { cat: 'screen', v: 0.12 };
      case E.PROTECT: return { cat: 'protect', v: 0.08 };
      case E.ENCORE: case E.PERISH_SONG: case E.MEMENTO: return { cat: 'misc', v: 0.1 };
      case E.TAUNT: return { cat: 'misc', v: 0.07 };
      case E.ATTACK_DOWN_2: return { cat: 'debuff', v: 0.12 * acc };
      case E.DEFENSE_DOWN_2: case E.SPDEF_DOWN_2: case E.SPEED_DOWN_2: return { cat: 'debuff', v: 0.08 * acc };
      case E.EVASION_UP: return { cat: 'evade', v: 0.1 };
      case E.DEFENSE_UP_2: case E.SPDEF_UP_2: case E.COSMIC_POWER: return { cat: 'defup', v: 0.1 };
      case E.METRONOME: return { cat: 'misc', v: 0.1 };
      case E.SPLASH: return { cat: 'splash', v: 0 };
      case E.HAZE: return { cat: 'misc', v: 0.04 };
      default: return { cat: 'other' + mv.effect, v: 0.03 * acc };
    }
  }

  function isAttack(mv) {
    const e = mv.effect;
    if ([E.LEVEL_DAMAGE, E.PSYWAVE, E.SUPER_FANG, E.DRAGON_RAGE, E.SONICBOOM, E.OHKO, E.COUNTER, E.MIRROR_COAT,
      E.ENDEAVOR, E.BIDE, E.RETURN, E.FRUSTRATION, E.FLAIL, E.MAGNITUDE, E.PRESENT, E.HIDDEN_POWER, E.LOW_KICK,
      E.SPIT_UP, E.BEAT_UP, E.TRIPLE_KICK].includes(e)) return true;
    return mv.power > 1;
  }

  function pickMoves(rom, mon, targets) {
    const pool = learnableMoves(rom, mon.sid).map(id => rom.moves[id]);
    const attacks = pool.filter(isAttack);
    const statuses = pool.filter(m => !isAttack(m));
    const score = new Map();
    attacks.forEach(m => score.set(m.id, targets.map(t => attackScore(rom, mon, m, t))));
    const soft = (x) => (x <= 1 ? x : Math.min(1.6, 1 + 0.3 * (x - 1)));
    function evaluate(set) {
      let dmg = 0, phys = 0, spec = 0;
      targets.forEach((t, i) => {
        let best = 0, bp = 0, bs = 0;
        set.forEach(m => {
          const sc = score.get(m.id);
          if (!sc) return;
          const v = soft(sc[i]);
          if (v > best) best = v;
          if (PHYS(m.type)) { if (v > bp) bp = v; } else if (v > bs) bs = v;
        });
        dmg += best; if (bp > 0) phys += 1.05 - Math.min(1, bp); if (bs > 0) spec += 1.05 - Math.min(1, bs);
      });
      const cats = {};
      set.forEach(m => {
        if (score.has(m.id)) return;
        const sv = statusValue(m, phys, spec, mon);
        if (!(sv.cat in cats) || cats[sv.cat] < sv.v) cats[sv.cat] = sv.v;
      });
      const extras = Object.values(cats).sort((a, b) => b - a);
      const usefulAttacks = set.filter(m => score.has(m.id) && Math.max(...score.get(m.id)) > 0.05).length;
      const allowed = attacks.filter(m => Math.max(...score.get(m.id)) > 0.05).length >= 2 ? 2 : 4;
      let total = dmg;
      extras.slice(0, allowed).forEach(v => { total += v; });
      extras.slice(allowed).forEach(v => { total -= 0.5; });
      return total + usefulAttacks * 1e-3;
    }
    const chosen = [];
    const all = attacks.concat(statuses);
    const solo = new Map(all.map(m => [m.id, evaluate([m])]));
    while (chosen.length < 4 && chosen.length < all.length) {
      const baseVal = evaluate(chosen);
      let best = null, bestGain = -1, bestSolo = -1;
      for (const m of all) {
        if (chosen.includes(m)) continue;
        const gain = evaluate(chosen.concat([m])) - baseVal;
        const s = solo.get(m.id);
        if (gain > bestGain + 1e-9 || (Math.abs(gain - bestGain) <= 1e-9 && s > bestSolo)) { best = m; bestGain = gain; bestSolo = s; }
      }
      if (!best) break;
      chosen.push(best);
    }
    // order: strongest attacks first, then support moves
    chosen.sort((a, b) => solo.get(b.id) - solo.get(a.id));
    return chosen.map(m => m.id);
  }

  // ---------- Abilities ----------
  const ABILITY_RANK = { 37: 9, 74: 9, 25: 8, 3: 8, 26: 7, 22: 7, 47: 6, 33: 6, 34: 6, 62: 6, 63: 5, 2: 6, 70: 6, 45: 5, 30: 5,
    32: 5, 10: 5, 11: 5, 18: 5, 9: 4, 49: 4, 27: 4, 24: 4, 61: 4, 5: 3, 29: 3, 39: 3, 28: 3, 14: 3, 55: 3,
    50: 0, 53: 0, 35: 0, 1: 0, 57: 0, 58: 0, 31: 0, 21: 0, 60: 0, 54: 0, 6: 1, 19: 1 };

  // ---------- Daily team ----------
  const START_DATE = '2026-10-13';
  function dayNumber(dateStr) {
    const a = Date.UTC(+START_DATE.slice(0, 4), +START_DATE.slice(5, 7) - 1, +START_DATE.slice(8, 10));
    const b = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
    return Math.round((b - a) / 86400000) + 1;
  }

  function isShiny(pers, otId) {
    return (((otId >>> 16) ^ (otId & 0xFFFF) ^ (pers >>> 16) ^ (pers & 0xFFFF)) & 0xFFFF) < 8;
  }

  function makeTeam(rom, seedStr, opts) {
    opts = opts || {};
    const rng = makeRng('daily-red|' + seedStr);
    const otId = opts.otId >>> 0;
    const targets = redTeam(rom);
    // Only fully evolved Pokemon, and no type may appear twice across the team.
    const finals = [];
    for (let n = 1; n <= 386; n++) { const sp = rom.species[rom.natToSpecies[n]]; if (!sp.evolves) finals.push(n); }
    const typesOf = (n) => [...new Set(rom.species[rom.natToSpecies[n]].types)];
    let picked = [];
    for (let attempt = 0; attempt < 50 && picked.length < 6; attempt++) {
      picked = (opts.species || []).slice(0, 6);
      const used = new Set();
      picked.forEach(n => typesOf(n).forEach(t => used.add(t)));
      for (let tries = 0; tries < 5000 && picked.length < 6; tries++) {
        const n = finals[rng.int(finals.length)];
        if (picked.includes(n) || typesOf(n).some(t => used.has(t))) continue;
        picked.push(n);
        typesOf(n).forEach(t => used.add(t));
      }
    }
    return picked.map(nat => {
      const sid = rom.natToSpecies[nat];
      const sp = rom.species[sid];
      // ability
      let abilityNum = 0;
      if (sp.abilities[1] && sp.abilities[1] !== sp.abilities[0]) {
        const r0 = ABILITY_RANK[sp.abilities[0]] ?? 2, r1 = ABILITY_RANK[sp.abilities[1]] ?? 2;
        abilityNum = r1 > r0 ? 1 : r0 > r1 ? 0 : rng.int(2);
      }
      const ability = sp.abilities[abilityNum];
      const mon = { sid, sp, lvl: 100, types: sp.types, ability, stats: calcStats(sp, 100, IV31, EV0, 0) };
      let moves = pickMoves(rom, mon, targets);
      // nature from the moves chosen
      let phys = 0, spec = 0;
      moves.forEach(id => { const m = rom.moves[id]; if (isAttack(m)) { if (PHYS(m.type)) phys++; else spec++; } });
      let nature;
      if (phys && !spec) nature = sp.base.spe >= 80 ? 13 : 3;      // Jolly / Adamant
      else if (spec && !phys) nature = sp.base.spe >= 80 ? 10 : 15; // Timid / Modest
      else if (phys && spec) nature = sp.base.atk >= sp.base.spa ? 1 : 16; // Lonely / Mild
      else nature = 20; // Calm
      mon.stats = calcStats(sp, 100, IV31, EV0, nature);
      moves = pickMoves(rom, mon, targets);
      let pers;
      for (let t = 0; t < 100000; t++) {
        pers = rng.u32();
        if (pers % 25 === nature && !isShiny(pers, otId)) break;
      }
      return {
        sid, nat, name: sp.name, types: sp.types, ability, abilityNum, nature, natureName: NATURE_NAMES[nature],
        personality: pers, moves, stats: mon.stats, lvl: 100, exp: rom.expAt100(sp.growth),
      };
    });
  }

  // ---------- Save file ----------
  const SUBSTRUCT_ORDER = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
    'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];

  function encodePartyMon(rom, m, ot) {
    const out = new Uint8Array(100);
    w32(out, 0, m.personality); w32(out, 4, ot.id);
    encodeText(m.name, 10).forEach((c, i) => { out[8 + i] = c; });
    out[0x12] = 2; // English
    out[0x13] = 0x02; // hasSpecies
    encodeText(ot.name, 7).forEach((c, i) => { out[0x14 + i] = c; });
    const G = new Uint8Array(12), A = new Uint8Array(12), Ev = new Uint8Array(12), M = new Uint8Array(12);
    w16(G, 0, m.sid); w16(G, 2, 0); w32(G, 4, m.exp); G[8] = 0xFF; G[9] = 255;
    m.moves.forEach((id, i) => {
      w16(A, i * 2, id);
      const base = rom.moves[id].pp;
      A[8 + i] = Math.min(255, base + Math.floor(base / 5) * 3);
    });
    M[0] = 0; M[1] = 65; // met at Mt. Pyre
    const ball = 4;
    w16(M, 2, (100 & 0x7F) | (3 << 7) | (ball << 11) | ((ot.gender & 1) << 15));
    const ivWord = (31) | (31 << 5) | (31 << 10) | (31 << 15) | (31 << 20) | (31 << 25) | ((m.abilityNum & 1) << 31);
    w32(M, 4, ivWord >>> 0);
    w32(M, 8, 0x80000000); // obedient (Mew / Deoxys)
    const parts = { G, A, E: Ev, M };
    const order = SUBSTRUCT_ORDER[m.personality % 24];
    const plain = new Uint8Array(48);
    for (let i = 0; i < 4; i++) plain.set(parts[order[i]], i * 12);
    let sum = 0;
    for (let i = 0; i < 48; i += 2) sum = (sum + u16(plain, i)) & 0xFFFF;
    w16(out, 0x1C, sum);
    const key = (m.personality ^ ot.id) >>> 0;
    for (let i = 0; i < 48; i += 4) w32(out, 0x20 + i, (u32(plain, i) ^ key) >>> 0);
    w32(out, 0x50, 0); out[0x54] = 100; out[0x55] = 0xFF;
    const s = m.stats;
    w16(out, 0x56, ot.testHp ? Math.min(ot.testHp, s.hp) : s.hp); w16(out, 0x58, s.hp); w16(out, 0x5A, s.atk); w16(out, 0x5C, s.def);
    w16(out, 0x5E, s.spe); w16(out, 0x60, s.spa); w16(out, 0x62, s.spd);
    return out;
  }

  const SUMMIT = { group: 24, num: 22, startX: 23, startY: 8, redX: 23, redY: 5 };

  function buildSave(rom, team, player) {
    const SB2_SIZE = 0xF2C, SB1_SIZE = 0x3D88, PKS_SIZE = 0x83D0;
    const sb2 = new Uint8Array(SB2_SIZE), sb1 = new Uint8Array(SB1_SIZE), pks = new Uint8Array(PKS_SIZE);
    // SaveBlock2
    encodeText(player.name, 8).forEach((c, i) => { sb2[i] = c; });
    sb2[0x08] = player.gender & 1;
    sb2[0x09] = 1; // CONTINUE_GAME_WARP
    w32(sb2, 0x0A, player.id >>> 0);
    sb2[0x13] = 0; // button mode normal
    // text speed FAST (2), frame 0, mono, SHIFT style, animations on
    w16(sb2, 0x14, 2 | (player.battleStyleSet ? 1 << 9 : 0) | (player.animsOff ? 1 << 10 : 0));
    // SaveBlock1
    const warp = (o) => { sb1[o] = SUMMIT.group; sb1[o + 1] = SUMMIT.num; sb1[o + 2] = 0xFF; sb1[o + 3] = 0; w16(sb1, o + 4, SUMMIT.startX); w16(sb1, o + 6, SUMMIT.startY); };
    w16(sb1, 0x00, SUMMIT.startX); w16(sb1, 0x02, SUMMIT.startY);
    warp(0x04); warp(0x0C); warp(0x14); warp(0x1C); warp(0x24);
    sb1[0x2E] = 4; // snow
    w16(sb1, 0x32, 303);
    sb1[0x234] = team.length;
    team.forEach((m, i) => sb1.set(encodePartyMon(rom, m, { id: player.id >>> 0, name: player.name, gender: player.gender, testHp: player.testHp }), 0x238 + i * 100));
    w32(sb1, 0x490, 3000);
    const setFlag = (f) => { sb1[0x1270 + (f >> 3)] |= 1 << (f & 7); };
    [0x860, 0x8C0, 0x112].forEach(setFlag); // POKEMON_GET, B_DASH (running shoes), RECEIVED_RUNNING_SHOES
    // Flash image: two slots of 14 sectors, then extra sectors. Unused space is erased (0xFF).
    const flash = new Uint8Array(0x20000).fill(0xFF);
    const chunks = [[sb2, 0, SB2_SIZE]];
    for (let i = 0; i < 4; i++) chunks.push([sb1, i * 3968, Math.min(3968, SB1_SIZE - i * 3968)]);
    for (let i = 0; i < 9; i++) chunks.push([pks, i * 3968, Math.min(3968, PKS_SIZE - i * 3968)]);
    chunks.forEach(([src, off, size], id) => {
      const base = id * 0x1000;
      flash.fill(0, base, base + 0x1000);
      flash.set(src.subarray(off, off + size), base);
      let sum = 0;
      for (let i = 0; i < size; i += 4) sum = (sum + u32(flash, base + i)) >>> 0;
      const chk = ((sum >>> 16) + sum) & 0xFFFF;
      w16(flash, base + 0xFF4, id); w16(flash, base + 0xFF6, chk);
      w32(flash, base + 0xFF8, 0x08012025); w32(flash, base + 0xFFC, 2); // even counter selects slot 1
    });
    return flash;
  }

  // ---------- LZ77 sanity check ----------
  function lzDecodes(u8, off) {
    if (u8[off] !== 0x10) return false;
    const size = u32(u8, off) >>> 8;
    let o = off + 4, n = 0;
    while (n < size) {
      const flags = u8[o++];
      for (let b = 0; b < 8 && n < size; b++) {
        if (flags & (0x80 >> b)) {
          const v = (u8[o] << 8) | u8[o + 1]; o += 2;
          const disp = (v & 0xFFF) + 1;
          if (disp > n) return false;
          n += (v >> 12) + 3;
        } else { o++; n++; }
      }
      if (o > u8.length) return false;
    }
    return true;
  }
  function lzLiteral(bytes) { // valid LZ77 stream with no compression
    const out = [0x10, bytes.length & 255, (bytes.length >> 8) & 255, (bytes.length >> 16) & 255];
    for (let i = 0; i < bytes.length; i += 8) { out.push(0); for (let k = 0; k < 8; k++) out.push(i + k < bytes.length ? bytes[i + k] : 0); }
    return out;
  }
  // Brendan's trainer palette (RGB), used to repair ROM dumps where it is damaged.
  const BRENDAN_PAL = [[115,197,164],[255,222,205],[222,164,148],[205,131,115],[123,90,82],[98,123,156],[74,90,131],[49,65,106],[24,41,82],[222,230,238],[139,222,115],[98,156,90],[255,98,90],[197,65,65],[255,255,255],[0,0,0]];

  // ---------- ROM patch ----------
  const TRAINER_ID = 23; // reuses an unused Mt. Pyre grunt slot
  const TRAINER_CLASS = 0x3B; // a Frontier Brain class, for the Frontier Brain battle theme
  const RED_FLAG = 0x358; // FLAG_HIDE_MT_PYRE_SUMMIT_MAXIE (clear in a fresh save)

  function patchRom(rom, opts) {
    opts = opts || {};
    const src = rom.u8;
    const out = new Uint8Array(src.length);
    out.set(src);
    let free = OFF.free;
    const alloc = (bytes) => { const at = free; out.set(bytes, at); free += bytes.length; free = (free + 3) & ~3; return at; };
    const gp = (o) => (0x08000000 + o) >>> 0;
    const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const le16 = (v) => [v & 255, (v >> 8) & 255];

    // repair Brendan's palette if this dump has it damaged (it shows on his back sprite in battle)
    const BRENDAN_PAL_PTRS = [0x30593C + 71 * 8, 0x305D8C];
    if (!lzDecodes(out, ptr(out, BRENDAN_PAL_PTRS[0]))) {
      const raw = [];
      BRENDAN_PAL.forEach(([r, g, b]) => { const c = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10); raw.push(c & 255, c >> 8); });
      const at = alloc(lzLiteral(raw));
      BRENDAN_PAL_PTRS.forEach(p => { if (ptr(out, p) === ptr(src, BRENDAN_PAL_PTRS[0])) w32(out, p, gp(at)); });
    }

    // the player's front pics (trainer card) are damaged in some dumps: fall back to the R/S versions
    [[71, 91], [72, 92]].forEach(([pic, alt]) => {
      if (!lzDecodes(out, ptr(out, 0x305654 + pic * 8))) {
        w32(out, 0x305654 + pic * 8, u32(out, 0x305654 + alt * 8));
        w32(out, 0x30593C + pic * 8, u32(out, 0x30593C + alt * 8));
      }
    });

    // text
    const ELLIPSIS = 0xB0, PARA = 0xFB;
    const introText = alloc([ELLIPSIS, PARA, ELLIPSIS, 0xFF]);
    const defeatText = alloc([ELLIPSIS, 0xFF]);
    const postText = alloc([ELLIPSIS, 0xFF]);
    const silverName = alloc(encodeText('MT. SILVER'));

    // Red's party
    const party = [];
    RED_TEAM.forEach(r => {
      const sid = speciesByName(rom, r.species);
      const lvl = opts.redLevel || r.lvl;
      party.push(...le16(255), lvl, 0, ...le16(sid));
      r.moves.forEach(n => party.push(...le16(rom.moveByName[n])));
      party.push(0, 0); // agbcc pads structs to 4 bytes
    });
    const partyAt = alloc(party);

    // trainer entry
    const t = OFF.trainers + TRAINER_ID * 40;
    out[t] = 1; // custom moves, no held items
    out[t + 1] = TRAINER_CLASS;
    out[t + 2] = 0;
    out[t + 3] = 89; // TRAINER_PIC_RED
    encodeText('RED', 12).forEach((c, i) => { out[t + 4 + i] = c; });
    for (let i = 0; i < 8; i++) out[t + 0x10 + i] = 0;
    out[t + 0x18] = 0; out[t + 0x19] = 0; out[t + 0x1A] = 0; out[t + 0x1B] = 0;
    w32(out, t + 0x1C, 0x7); // check bad move, try to faint, check viability
    out[t + 0x20] = 6;
    w32(out, t + 0x24, gp(partyAt));
    // class name
    const pkmnTrainer = [0x53, 0x54, 0x00, 0xCE, 0xCC, 0xBB, 0xC3, 0xC8, 0xBF, 0xCC, 0xFF, 0x00, 0x00];
    out.set(pkmnTrainer, OFF.trainerClassNames + TRAINER_CLASS * 13);
    // region map name (map popup)
    w32(out, OFF.regionMapEntries + 65 * 8 + 4, gp(silverName));

    // scripts
    const afterBattle = [];
    const S = (...b) => afterBattle.push(...b);
    // runs after Red is beaten
    S(0x67, ...le32(gp(postText)), 0x66, 0x6D, 0x68); // message, waitmessage, waitbuttonpress, closemessage
    S(0x97, 1); // fade to black
    S(0x53, ...le16(1)); // removeobject 1
    S(0x29, ...le16(RED_FLAG));
    S(0x97, 0); // fade from black
    S(0x6C, 0x02); // release, end
    const afterAt = alloc(afterBattle);
    const main = [0x5C, 1, ...le16(TRAINER_ID), ...le16(0), ...le32(gp(introText)), ...le32(gp(defeatText)), ...le32(gp(afterAt)),
      0x67, ...le32(gp(postText)), 0x66, 0x6D, 0x68, 0x6C, 0x02];
    const scriptAt = alloc(main);

    // Red's object event
    const obj = new Uint8Array(24);
    obj[0] = 1; obj[1] = 230; obj[2] = 0;
    w16(obj, 4, SUMMIT.redX); w16(obj, 6, SUMMIT.redY);
    obj[8] = 3; obj[9] = 0x08; // FACE_DOWN
    w16(obj, 0x0C, 1); w16(obj, 0x0E, 1); // trainer, sight 1
    w32(obj, 0x10, gp(scriptAt));
    w16(obj, 0x14, RED_FLAG);
    const objAt = alloc(obj);

    // map header and events
    const group = ptr(out, OFF.mapGroups + SUMMIT.group * 4);
    const header = ptr(out, group + SUMMIT.num * 4);
    const oldEvents = ptr(out, header + 4);
    const events = new Uint8Array(20);
    events[0] = 1; events[1] = out[oldEvents + 1]; events[2] = 0; events[3] = 0;
    w32(events, 4, gp(objAt));
    w32(events, 8, u32(out, oldEvents + 8));
    const eventsAt = alloc(events);
    const noScripts = alloc([0, 0, 0, 0]);
    w32(out, header + 4, gp(eventsAt));
    w32(out, header + 8, gp(noScripts));
    w16(out, header + 0x10, 0xFFFF); // silence on the summit
    out[header + 0x16] = 4; // snow
    return out;
  }

  // ---------- Sprites (for the page around the game screen) ----------
  function lzDecode(u8, off) {
    const size = u32(u8, off) >>> 8;
    const out = new Uint8Array(size);
    let o = off + 4, n = 0;
    while (n < size) {
      const flags = u8[o++];
      for (let b = 0; b < 8 && n < size; b++) {
        if (flags & (0x80 >> b)) {
          const v = (u8[o] << 8) | u8[o + 1]; o += 2;
          const len = (v >> 12) + 3, disp = (v & 0xFFF) + 1;
          if (disp > n) throw new Error('bad LZ77 data');
          for (let k = 0; k < len && n < size; k++, n++) out[n] = out[n - disp];
        } else out[n++] = u8[o++];
      }
    }
    return out;
  }
  function decodePic(u8, picOff, palOff, w, h) {
    const tiles = lzDecode(u8, picOff), pal = lzDecode(u8, palOff);
    const rgba = new Uint8ClampedArray(w * h * 4);
    const tw = w / 8;
    for (let t = 0; t < tw * (h / 8); t++) {
      const tx = (t % tw) * 8, ty = Math.floor(t / tw) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const byte = tiles[t * 32 + y * 4 + (x >> 1)];
        const ci = (x & 1) ? byte >> 4 : byte & 15;
        if (!ci) continue;
        const c = pal[ci * 2] | (pal[ci * 2 + 1] << 8);
        const p = ((ty + y) * w + tx + x) * 4;
        rgba[p] = (c & 31) * 255 / 31; rgba[p + 1] = ((c >> 5) & 31) * 255 / 31; rgba[p + 2] = ((c >> 10) & 31) * 255 / 31; rgba[p + 3] = 255;
      }
    }
    return { w, h, rgba };
  }
  function monSprite(rom, sid) {
    return decodePic(rom.u8, ptr(rom.u8, 0x30A18C + sid * 8), ptr(rom.u8, 0x303678 + sid * 8), 64, 64);
  }
  function trainerSprite(rom, pic) {
    return decodePic(rom.u8, ptr(rom.u8, 0x305654 + pic * 8), ptr(rom.u8, 0x30593C + pic * 8), 64, 64);
  }

  const api = {
    monSprite, trainerSprite,
    OFF, RAM, CB2, SUMMIT, TRAINER_ID, RED_TEAM, TYPE_NAMES, NATURE_NAMES,
    decodeText, encodeText, checkRom, parseRom, makeTeam, redTeam, buildSave, patchRom, learnableMoves,
    dayNumber, makeRng, typeMult, pickMoves,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DailyRedCore = api;
})(typeof window !== 'undefined' ? window : this);
