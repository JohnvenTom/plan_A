// editor.js — custom training-range editor: a tactical-map scenario builder.
// Place targets (passive drone / missile launcher / AI fighter), draw
// waypoint chains with per-leg speed & altitude, set the tail behavior
// (loop the chain or settle into an orbit), drag the player spawn with
// heading/alt/speed — then fly it. Scenarios persist to localStorage
// (multi-slot) and export/import as JSON, debrief-style.
//
// Pure data helpers (defaultScenario / validateScenario / scenarioToCourse)
// are exported headless-testable; the RangeEditor class owns the DOM.
import { terrainHeightAt, SEA_LEVEL } from '../world/terrain.js';

const WORLD = 16000;          // map half-extent, metres
export const MAX_TARGETS = 8;
const MAX_SCENARIOS = 12;
const STORE_KEY = 'sb_custom_ranges';
// placement warning line: the runtime kills a drone at ground+8 m (belly
// clearance); warn at +30 so there is room to fix it in 50 m panel steps
const WARN_AGL = 30;

// effective ground under a point: terrain, or the sea surface offshore
function groundAt(x, z) { return Math.max(terrainHeightAt(x, z), SEA_LEVEL); }
function underground(x, z, alt) { return alt < groundAt(x, z) + WARN_AGL; }

export function defaultScenario() {
  return {
    name: '新方案',
    player: { x: 0, z: 8000, alt: 900, speed: 300, heading: 0 },
    targets: [],
  };
}

// structural sanity for launch: numbers finite, caps respected. Returns a
// list of human-readable problems (empty = good to fly).
export function validateScenario(sc) {
  const errs = [];
  if (!sc || typeof sc !== 'object') return ['方案数据缺失'];
  if (!sc.player || [sc.player.x, sc.player.z, sc.player.alt, sc.player.speed].some(v => !Number.isFinite(v)))
    errs.push('玩家出生点参数不完整');
  if (!Array.isArray(sc.targets)) errs.push('目标列表缺失');
  else {
    if (sc.targets.length > MAX_TARGETS) errs.push(`目标数超过上限 ${MAX_TARGETS}`);
    sc.targets.forEach((t, i) => {
      if (!['drone', 'launcher', 'fighter'].includes(t.type)) errs.push(`目标${i + 1}: 未知类型`);
      if (![t.x, t.z, t.alt, t.speed].every(v => Number.isFinite(v))) errs.push(`目标${i + 1}: 参数不完整`);
      if (t.alt < 30) errs.push(`目标${i + 1}: 高度过低`);
      if (Array.isArray(t.path)) t.path.forEach((w, j) => {
        if (![w.x, w.z].every(v => Number.isFinite(v))) errs.push(`目标${i + 1} 航点${j + 1}: 坐标无效`);
      });
    });
  }
  return errs;
}

// scenario -> training course config (the shape startTraining consumes)
export function scenarioToCourse(sc) {
  return {
    title: 'CUSTOM RANGE',
    sub: `自定义靶场 — ${sc.name || '未命名'}`,
    hot: 'RANGE HOT — CUSTOM LAYOUT',
    spawn: { x: sc.player.x, z: sc.player.z, alt: sc.player.alt, speed: sc.player.speed, heading: sc.player.heading },
    drones: sc.targets.filter(t => t.type !== 'fighter').map(t => ({
      center: { x: t.x, z: t.z },
      alt: t.alt, speed: t.speed,
      path: (t.path || []).map(w => ({ x: w.x, z: w.z, alt: w.alt, speed: w.speed })),
      tail: t.tail || 'loop',
      launch: t.type === 'launcher' ? { kind: t.launch?.kind || 'alt', interval: t.launch?.interval || 12 } : undefined,
    })),
    fighters: sc.targets.filter(t => t.type === 'fighter').map(t => ({ x: t.x, z: t.z, alt: t.alt })),
  };
}

// ---------- DOM helpers ----------
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function num(v, fallback) { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; }

const TYPE_META = {
  drone: { label: '靶机', color: '#9fd0ff', sym: '◎' },
  launcher: { label: '发射平台', color: '#ff9a8a', sym: '▲' },
  fighter: { label: '战斗机', color: '#ffd27a', sym: '◆' },
};

export class RangeEditor {
  constructor({ onStart }) {
    this.onStart = onStart;
    this._open = false;
    this._tool = 'select';
    this._sel = null;              // {kind:'target'|'wp'|'player', ti, wi}
    this._drag = null;
    this._list = this._loadList();
    this._fid = 0;                 // form-field uid: every input/select gets a
                                   // unique name (browser autofill audit)
    this._build();
  }

  isOpen() { return this._open; }

  _build() {
    const root = document.getElementById('editor');
    this.root = root;
    // swallow the phases that could start a mission (mousedown/click/keydown
    // all reach input.js's window listeners). mouseup is deliberately NOT
    // swallowed: the drag-release listener below must see it, and a leaked
    // mouseup only clears a button flag that was never set anyway
    for (const type of ['mousedown', 'click', 'keydown']) {
      root.addEventListener(type, e => e.stopPropagation());
    }
    const panel = el('div', 'ed-panel');
    panel.appendChild(el('div', 'ed-title', '<span class="ed-en">RANGE EDITOR</span> 自定义靶场'));
    const body = el('div', 'ed-body');

    // ---- left: the tactical map ----
    const mapWrap = el('div', 'ed-mapwrap');
    this.canvas = el('canvas', 'ed-map');
    const SZ = 640;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.SZ = SZ; this.dpr = dpr;
    this.canvas.width = SZ * dpr; this.canvas.height = SZ * dpr;
    this.canvas.style.width = SZ + 'px'; this.canvas.style.height = SZ + 'px';
    mapWrap.appendChild(this.canvas);
    // live terrain readout under the cursor (and clearance while dragging)
    this.elev = el('div', 'ed-elev', '地面海拔 — m');
    mapWrap.appendChild(this.elev);
    this.hint = el('div', 'ed-hint', '选择工具后点击地图放置目标 · 选中目标后可拖动 / 加航点');
    mapWrap.appendChild(this.hint);
    body.appendChild(mapWrap);

    // ---- right: tools + properties + scenario ----
    const side = el('div', 'ed-side');

    const tools = el('div', 'ed-tools');
    this._toolBtns = {};
    const toolDefs = [
      ['select', '⌖ 选择/拖动'],
      ['place-drone', '◎ 放置靶机'],
      ['place-launcher', '▲ 放置发射平台'],
      ['place-fighter', '◆ 放置战斗机'],
      ['addwp', '＋ 加航点'],
    ];
    for (const [id, label] of toolDefs) {
      const b = el('div', 'ed-tool', label);
      b.addEventListener('click', () => { this._tool = id; this._syncTools(); });
      tools.appendChild(b);
      this._toolBtns[id] = b;
    }
    const del = el('div', 'ed-tool ed-danger', '✕ 删除选中');
    del.addEventListener('click', () => this._deleteSelected());
    tools.appendChild(del);
    side.appendChild(tools);

    this.props = el('div', 'ed-props');
    side.appendChild(this.props);

    // ---- scenario bar ----
    const sbar = el('div', 'ed-sbar');
    this.nameInput = el('input', 'ed-name');
    this.nameInput.type = 'text'; this.nameInput.maxLength = 24;
    this.nameInput.name = 'ed-scenario-name';
    this.nameInput.id = 'ed-scenario-name';
    this.nameInput.autocomplete = 'off';
    this.nameInput.addEventListener('input', () => { if (this.sc) this.sc.name = this.nameInput.value; });
    sbar.appendChild(this.nameInput);
    const btns = [
      ['新建', () => this._newScenario()],
      ['保存', () => this._saveScenario()],
      ['另存', () => this._saveScenario(true)],
      ['删除', () => this._deleteScenario()],
      ['导出', () => this._exportScenario()],
    ];
    for (const [label, fn] of btns) {
      const b = el('div', 'ed-btn', label);
      b.addEventListener('click', fn);
      sbar.appendChild(b);
    }
    this.importInput = el('input');
    this.importInput.type = 'file'; this.importInput.accept = '.json,application/json';
    this.importInput.name = 'ed-import-file';
    this.importInput.style.display = 'none';
    this.importInput.addEventListener('change', () => this._importFile());
    const ib = el('div', 'ed-btn', '导入');
    ib.addEventListener('click', () => this.importInput.click());
    sbar.appendChild(ib);
    sbar.appendChild(this.importInput);
    this.listSel = el('select', 'ed-list');
    this.listSel.name = 'ed-scenario-list';
    this.listSel.addEventListener('change', () => this._loadScenario(this.listSel.value));
    sbar.appendChild(this.listSel);
    side.appendChild(sbar);

    const go = el('div', 'ed-go', '开始训练 ▶');
    go.addEventListener('click', () => this._launch());
    side.appendChild(go);

    body.appendChild(side);
    panel.appendChild(body);
    root.appendChild(panel);
    this._closeBtn = el('div', 'ed-close', '✕');
    this._closeBtn.addEventListener('click', () => this.close());
    root.appendChild(this._closeBtn);

    this.canvas.addEventListener('mousedown', e => this._down(e));
    this.canvas.addEventListener('mousemove', e => this._hoverElev(e));
    // drag release runs in CAPTURE phase on window: bubble-phase listeners
    // would never see a mouseup that inner stopPropagation eats — the exact
    // bug that glued dragged elements to the cursor forever. The buttons===0
    // guard also self-heals a release that happened outside the window.
    window.addEventListener('mousemove', e => {
      if (!this._drag) return;
      if (e.buttons === 0) { this._drag = null; return; }
      this._move(e);
    }, true);
    window.addEventListener('mouseup', () => { this._drag = null; }, true);

    this._terrain = this._paintTerrain();
    this._newScenario(true);
  }

  // ---------- lifecycle ----------
  open() {
    this._open = true;
    this.root.classList.remove('hidden');
    this._list = this._loadList();
    this._refreshList();
  }
  close() {
    this._open = false;
    this._drag = null;
    this.root.classList.add('hidden');
  }

  _launch() {
    const errs = validateScenario(this.sc);
    if (errs.length) { this.hint.textContent = '✕ ' + errs[0]; return; }
    this._saveScenario();          // flying it saves the layout
    this.close();
    this.onStart(JSON.parse(JSON.stringify(this.sc)));
  }

  // ---------- storage ----------
  _loadList() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
  }
  _storeList() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this._list)); } catch { /* private mode */ }
  }
  _refreshList() {
    this.listSel.innerHTML = '';
    for (let i = 0; i < this._list.length; i++) {
      const o = el('option');
      o.value = i; o.textContent = this._list[i].name;
      this.listSel.appendChild(o);
    }
    const o = el('option');
    o.value = -1; o.textContent = '— 当前编辑 —';
    this.listSel.appendChild(o);
    this.listSel.value = this._slot ?? -1;
  }
  _newScenario(silent) {
    this.sc = defaultScenario();
    this._slot = null;
    this._sel = null;
    this.nameInput.value = this.sc.name;
    if (!silent) this.hint.textContent = '已新建方案 — 放置目标后点「保存」';
    this._refreshList(); this._render();
  }
  _loadScenario(idx) {
    const i = parseInt(idx, 10);
    if (!(i >= 0 && i < this._list.length)) { this.listSel.value = this._slot ?? -1; return; }
    const item = this._list[i];
    this.sc = JSON.parse(JSON.stringify(item.data));
    this.sc.name = item.name;
    this._slot = i; this._sel = null;
    this.nameInput.value = this.sc.name;
    this.hint.textContent = `已载入「${item.name}」`;
    this._render();
  }
  _saveScenario(asCopy) {
    if (!this.sc.name) this.sc.name = '未命名';
    const entry = { name: this.sc.name, data: JSON.parse(JSON.stringify(this.sc)) };
    delete entry.data.name;
    if (asCopy || this._slot === null) {
      if (this._list.length >= MAX_SCENARIOS) { this.hint.textContent = `✕ 方案槽已满（${MAX_SCENARIOS}）`; return; }
      let name = this.sc.name, k = 2;
      while (this._list.some(it => it.name === name)) name = `${this.sc.name} ${k++}`;
      entry.name = name; this.sc.name = name;
      this._list.push(entry);
      this._slot = this._list.length - 1;
      this.nameInput.value = name;
    } else {
      this._list[this._slot] = entry;
    }
    this._storeList();
    this.hint.textContent = `已保存「${entry.name}」`;
    this._refreshList();
  }
  _deleteScenario() {
    if (this._slot === null) { this.hint.textContent = '当前是新方案，无槽可删'; return; }
    const name = this._list[this._slot]?.name;
    this._list.splice(this._slot, 1);
    this._slot = null;
    this._storeList();
    this.hint.textContent = `已删除「${name}」`;
    this._refreshList();
  }
  _exportScenario() {
    const data = JSON.parse(JSON.stringify(this.sc));
    const blob = new Blob([JSON.stringify({ app: 'sky-baroness', kind: 'custom-range', ...data }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `range_${(this.sc.name || 'untitled').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.hint.textContent = '已导出 JSON';
  }
  _importFile() {
    const f = this.importInput.files && this.importInput.files[0];
    this.importInput.value = '';
    if (!f) return;
    f.text().then(txt => {
      let sc;
      try { sc = JSON.parse(txt); } catch { this.hint.textContent = '✕ 文件不是合法 JSON'; return; }
      if (!Array.isArray(sc.targets)) { this.hint.textContent = '✕ 不是靶场方案文件'; return; }
      if (this._list.length >= MAX_SCENARIOS) { this.hint.textContent = `✕ 方案槽已满（${MAX_SCENARIOS}）`; return; }
      const clean = defaultScenario();
      Object.assign(clean.player, sc.player || {});
      clean.targets = (sc.targets || []).slice(0, MAX_TARGETS);
      clean.name = sc.name || f.name.replace(/\.json$/i, '');
      this.sc = clean;
      this._slot = null; this._sel = null;
      this.nameInput.value = clean.name;
      this._saveScenario();
      this._render();
      this.hint.textContent = `已导入「${clean.name}」`;
    });
  }

  // ---------- map ----------
  _paintTerrain() {
    // one-time terrain underlay: height-shaded land over dark sea
    const N = 160;
    const off = document.createElement('canvas');
    off.width = N; off.height = N;
    const ctx = off.getContext('2d');
    const img = ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const wx = (i / (N - 1)) * 2 * WORLD - WORLD;
        const wz = (j / (N - 1)) * 2 * WORLD - WORLD;
        const h = terrainHeightAt(wx, wz);
        const k = (j * N + i) * 4;
        let r, g, b;
        if (h < 1) { r = 10; g = 18; b = 34; }
        else {
          const t = Math.min(1, h / 900);
          r = 42 + t * 60; g = 64 + t * 44; b = 56 + t * 36;
        }
        img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }

  _w2p(v) { return (v + WORLD) / (2 * WORLD) * this.SZ; }
  _p2w(p) { return p / this.SZ * 2 * WORLD - WORLD; }

  _render() {
    const c = this.canvas.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.SZ, this.SZ);
    // terrain underlay + grid
    c.imageSmoothingEnabled = true;
    c.drawImage(this._terrain, 0, 0, this.SZ, this.SZ);
    c.strokeStyle = 'rgba(143, 224, 255, .10)';
    c.lineWidth = 1;
    c.font = '10px Consolas, monospace';
    c.fillStyle = 'rgba(143, 224, 255, .35)';
    for (let g = -12000; g <= 12000; g += 4000) {
      const p = this._w2p(g);
      c.beginPath(); c.moveTo(p, 0); c.lineTo(p, this.SZ); c.stroke();
      c.beginPath(); c.moveTo(0, p); c.lineTo(this.SZ, p); c.stroke();
    }
    for (let g = -12000; g <= 12000; g += 8000) {
      c.fillText(`${g / 1000}km`, this._w2p(g) + 3, 12);
    }
    // compass
    c.fillStyle = 'rgba(255, 210, 122, .8)';
    c.font = 'bold 13px Consolas, monospace';
    c.fillText('N', 14, 22);
    c.strokeStyle = 'rgba(255, 210, 122, .6)';
    c.beginPath(); c.moveTo(18, 40); c.lineTo(18, 26); c.stroke();

    const sc = this.sc;
    if (!sc) return;
    // targets + paths
    sc.targets.forEach((t, ti) => {
      const sel = this._sel?.kind === 'target' && this._sel.ti === ti;
      const meta = TYPE_META[t.type] || TYPE_META.drone;
      if (t.type !== 'fighter' && t.path && t.path.length) {
        // dashed chain
        c.strokeStyle = meta.color + '99';
        c.setLineDash([6, 5]); c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(this._w2p(t.x), this._w2p(t.z));
        for (const w of t.path) c.lineTo(this._w2p(w.x), this._w2p(w.z));
        if (t.tail === 'loop' && t.path.length > 1) {
          c.strokeStyle = meta.color + '55';
          c.lineTo(this._w2p(t.path[0].x), this._w2p(t.path[0].z));
        }
        c.stroke();
        c.setLineDash([]);
        // orbit marker on the last waypoint for tail=orbit
        if (t.tail !== 'loop' && t.path.length) {
          const lw = t.path[t.path.length - 1];
          c.strokeStyle = meta.color + '55';
          c.setLineDash([3, 4]);
          c.beginPath();
          c.arc(this._w2p(lw.x), this._w2p(lw.z), this.SZ * 0.045, 0, Math.PI * 2);
          c.stroke();
          c.setLineDash([]);
        }
        // waypoint squares (red-framed when the leg's altitude is inside
        // the terrain at that point)
        t.path.forEach((w, wi) => {
          const wsel = sel && this._sel.kind === 'wp' && this._sel.wi === wi;
          const p = this._w2p(w.x), q = this._w2p(w.z);
          c.fillStyle = wsel ? '#fff' : meta.color;
          c.fillRect(p - 3.5, q - 3.5, 7, 7);
          if (underground(w.x, w.z, w.alt ?? t.alt)) {
            c.strokeStyle = '#ff5f4d'; c.lineWidth = 2;
            c.strokeRect(p - 5, q - 5, 10, 10);
          }
          if (wsel) { c.strokeStyle = '#fff'; c.beginPath(); c.arc(p, q, 8, 0, Math.PI * 2); c.stroke(); }
        });
      } else if (t.type !== 'fighter') {
        // bare target: it orbits in place — show the ring
        const r = Math.min(1600, Math.max(800, t.speed * 4)) / (2 * WORLD) * this.SZ;
        c.strokeStyle = meta.color + '44';
        c.setLineDash([3, 4]);
        c.beginPath(); c.arc(this._w2p(t.x), this._w2p(t.z), r, 0, Math.PI * 2); c.stroke();
        c.setLineDash([]);
      }
      // the target marker
      const p = this._w2p(t.x), q = this._w2p(t.z);
      if (sel) {
        c.strokeStyle = '#fff';
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(p, q, 13, 0, Math.PI * 2); c.stroke();
      }
      c.fillStyle = meta.color;
      c.font = 'bold 12px Consolas, monospace';
      c.textAlign = 'center';
      c.fillText(meta.sym, p, q + 4);
      // underground marker: the placement will spawn inside the terrain
      if (underground(t.x, t.z, t.alt)) {
        c.fillStyle = '#ff5f4d';
        c.font = 'bold 13px Consolas, monospace';
        c.fillText('⚠', p + 14, q - 8);
      }
      c.font = '10px Consolas, monospace';
      c.fillText(String(ti + 1), p, q + 17);
      c.textAlign = 'left';
    });
    // player spawn
    const P = sc.player;
    const px = this._w2p(P.x), pz = this._w2p(P.z);
    const psel = this._sel?.kind === 'player';
    c.strokeStyle = psel ? '#fff' : '#ffd27a';
    c.lineWidth = 2;
    c.beginPath(); c.arc(px, pz, 9, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(px, pz); c.lineTo(px, pz - 5); c.stroke();
    const h = (P.heading || 0) * Math.PI / 180;
    const dx = -Math.sin(h), dz = -Math.cos(h);           // heading 0 = north = -Z = up on map
    c.strokeStyle = psel ? '#fff' : '#ffd27a';
    c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(px, pz); c.lineTo(px + dx * 34, pz + dz * 34); c.stroke();
    c.fillStyle = '#ffd27a';
    c.font = '11px Consolas, monospace';
    c.fillText('YOU', px + 12, pz + 4);
    if (underground(P.x, P.z, P.alt)) {
      c.fillStyle = '#ff5f4d';
      c.font = 'bold 13px Consolas, monospace';
      c.fillText('⚠', px + 14, pz - 10);
    }
  }

  _syncTools() {
    for (const [id, b] of Object.entries(this._toolBtns)) b.classList.toggle('sel', id === this._tool);
    this.canvas.classList.toggle('placing', this._tool.startsWith('place'));
    if (this._tool === 'addwp') {
      const t = this._selTarget();
      if (!t || t.type === 'fighter') this.hint.textContent = '加航点：先选中一个靶机/发射平台';
      else this.hint.textContent = `点击地图为目标 ${this._sel.ti + 1} 追加航点`;
    } else if (this._tool.startsWith('place')) {
      this.hint.textContent = '点击地图放置';
    }
    this._render();
  }

  _selTarget() {
    return this._sel?.kind === 'target' || this._sel?.kind === 'wp'
      ? this.sc?.targets[this._sel.ti] : null;
  }

  _hit(mx, my) {
    // waypoints first (smaller), then targets, then the player spawn
    for (let ti = this.sc.targets.length - 1; ti >= 0; ti--) {
      const t = this.sc.targets[ti];
      if (t.type !== 'fighter' && t.path) {
        for (let wi = t.path.length - 1; wi >= 0; wi--) {
          const w = t.path[wi];
          if (Math.hypot(this._w2p(w.x) - mx, this._w2p(w.z) - my) < 9) return { kind: 'wp', ti, wi };
        }
      }
    }
    for (let ti = this.sc.targets.length - 1; ti >= 0; ti--) {
      const t = this.sc.targets[ti];
      if (Math.hypot(this._w2p(t.x) - mx, this._w2p(t.z) - my) < 13) return { kind: 'target', ti };
    }
    const P = this.sc.player;
    if (Math.hypot(this._w2p(P.x) - mx, this._w2p(P.z) - my) < 14) return { kind: 'player' };
    return null;
  }

  // live elevation readout: cursor terrain while browsing, dragged-object
  // clearance (with the underground warning) while moving things
  _hoverElev(e) {
    if (!this._open || this._drag) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (mx < 0 || my < 0 || mx > this.SZ || my > this.SZ) return;
    this._setElev(groundAt(this._p2w(mx), this._p2w(my)));
  }
  _setElev(g, extra, bad) {
    const base = g <= SEA_LEVEL ? '海面 (0 m)' : `地面海拔 ${Math.round(g)} m`;
    this.elev.textContent = extra ? `${base} · ${extra}` : base;
    this.elev.classList.toggle('bad', !!bad);
  }

  _down(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const hit = this._hit(mx, my);
    if (this._tool.startsWith('place')) {
      if (hit) { this.hint.textContent = '放置点与现有目标重叠'; return; }
      if (this.sc.targets.length >= MAX_TARGETS) { this.hint.textContent = `目标数已达上限 ${MAX_TARGETS}`; return; }
      const type = this._tool.slice(6);
      const t = {
        type, x: this._p2w(mx), z: this._p2w(my),
        alt: type === 'fighter' ? 3000 : 800, speed: 260,
        path: [], tail: 'loop',
      };
      if (type === 'launcher') t.launch = { kind: 'alt', interval: 12 };
      this.sc.targets.push(t);
      this._sel = { kind: 'target', ti: this.sc.targets.length - 1 };
      this._tool = 'select'; this._syncTools();
      const g = groundAt(t.x, t.z);
      this.hint.textContent = underground(t.x, t.z, t.alt)
        ? `⚠ ${TYPE_META[type].label}在此处将出生在地形内！地面 ${Math.round(g)} m，目标 ${t.alt} m — 请在右侧调高高度`
        : `已放置${TYPE_META[type].label}（此处${g <= SEA_LEVEL ? '海面' : `地面 ${Math.round(g)} m`}）— 拖动移动，用「＋ 加航点」规划路径`;
      this._renderProps();
      this._render();
      return;
    }
    if (this._tool === 'addwp') {
      const t = this._selTarget();
      if (!t) { this.hint.textContent = '先选中一个靶机/发射平台'; return; }
      if (t.type === 'fighter') { this.hint.textContent = '战斗机不走路点（AI 自主）'; return; }
      const w = { x: this._p2w(mx), z: this._p2w(my) };
      t.path.push(w);
      const wAlt = w.alt ?? t.alt;
      const g = groundAt(w.x, w.z);
      this.hint.textContent = underground(w.x, w.z, wAlt)
        ? `⚠ 航点 ${t.path.length} 在地形内！此处地面 ${Math.round(g)} m，到点高度 ${wAlt} m — 可在该航点行单独调高`
        : `航点 ${t.path.length} 已添加（此处${g <= SEA_LEVEL ? '海面' : `地面 ${Math.round(g)} m`}）— 继续点击追加，或切回选择工具`;
      this._renderProps(); this._render();
      return;
    }
    // select tool: pick & begin drag
    this._sel = hit;
    if (hit) this._drag = { ...hit, mx, my };
    this._renderProps();
    this._render();
  }

  _move(e) {
    if (!this._drag) return;
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (Math.hypot(mx - this._drag.mx, my - this._drag.my) < 2) return;
    this._drag.mx = mx; this._drag.my = my;
    const wx = this._p2w(mx), wz = this._p2w(my);
    let alt = null;
    if (this._drag.kind === 'player') { this.sc.player.x = wx; this.sc.player.z = wz; alt = this.sc.player.alt; }
    else {
      const t = this.sc.targets[this._drag.ti];
      if (this._drag.kind === 'wp') { const w = t.path[this._drag.wi]; w.x = wx; w.z = wz; alt = w.alt ?? t.alt; }
      else { t.x = wx; t.z = wz; alt = t.alt; }
    }
    // clearance readout follows the dragged object
    const g = groundAt(wx, wz);
    this._setElev(g, `高度 ${Math.round(alt)} m${underground(wx, wz, alt) ? ' ⚠ 低于地形安全线' : ''}`,
      underground(wx, wz, alt));
    this._renderProps();
    this._render();
  }

  _deleteSelected() {
    if (!this._sel) { this.hint.textContent = '没有选中项'; return; }
    if (this._sel.kind === 'wp') {
      const t = this.sc.targets[this._sel.ti];
      t.path.splice(this._sel.wi, 1);
      this._sel = { kind: 'target', ti: this._sel.ti };
    } else if (this._sel.kind === 'target') {
      this.sc.targets.splice(this._sel.ti, 1);
      this._sel = null;
    } else {
      this.hint.textContent = '玩家出生点不能删除（可拖动）';
      return;
    }
    this.hint.textContent = '已删除';
    this._renderProps(); this._render();
  }

  // ---------- properties panel ----------
  _row(label, input) {
    const r = el('div', 'ed-prow');
    r.appendChild(el('span', 'ed-plabel', label));
    r.appendChild(input);
    return r;
  }
  _numInput(val, min, max, step, onChange, name) {
    const i = el('input', 'ed-pnum');
    i.type = 'number'; i.value = Math.round(val); i.min = min; i.max = max; i.step = step ?? 1;
    i.name = name || `ed-field-${++this._fid}`;   // unique name: autofill audit
    i.autocomplete = 'off';
    i.addEventListener('change', () => {
      const v = num(i.value, val);
      onChange(Math.min(max, Math.max(min, v)));
      i.value = Math.round(v);
      this._render();
    });
    return i;
  }
  _selInput(options, val, onChange, name) {
    const s = el('select', 'ed-psel');
    s.name = name || `ed-field-${++this._fid}`;
    for (const [v, label] of options) {
      const o = el('option'); o.value = v; o.textContent = label; s.appendChild(o);
    }
    s.value = val;
    s.addEventListener('change', () => { onChange(s.value); this._render(); });
    return s;
  }

  // one-line local terrain readout for the properties panel
  _elevLine(x, z, alt) {
    const g = groundAt(x, z);
    const bad = underground(x, z, alt);
    const line = el('div', 'ed-elevline' + (bad ? ' bad' : ''));
    line.textContent = bad
      ? `⚠ 此处${g <= SEA_LEVEL ? '海面' : `地面 ${Math.round(g)} m`} — 高度 ${Math.round(alt)} m 在地形安全线以下`
      : `当地${g <= SEA_LEVEL ? '海面 (0 m)' : `地面海拔 ${Math.round(g)} m`}`;
    return line;
  }

  _renderProps() {
    const p = this.props;
    p.innerHTML = '';
    if (!this._sel) {
      p.appendChild(el('div', 'ed-pnone', '未选中 — 点击地图上的目标<br>或放置新目标'));
      return;
    }
    if (this._sel.kind === 'player') {
      const P = this.sc.player;
      p.appendChild(el('div', 'ed-phead', '⊕ 玩家出生点'));
      p.appendChild(this._elevLine(P.x, P.z, P.alt));
      p.appendChild(this._row('高度 m', this._numInput(P.alt, 50, 12000, 50, v => P.alt = v, 'ed-player-alt')));
      p.appendChild(this._row('速度 m/s', this._numInput(P.speed, 100, 600, 10, v => P.speed = v, 'ed-player-speed')));
      p.appendChild(this._row('朝向 °', this._numInput(P.heading, -180, 180, 5, v => P.heading = v, 'ed-player-heading')));
      p.appendChild(el('div', 'ed-pnote', '位置：地图上拖动 ⊕'));
      return;
    }
    const t = this.sc.targets[this._sel.ti];
    if (!t) { this._sel = null; return; }
    const meta = TYPE_META[t.type];
    const ti = this._sel.ti;
    p.appendChild(el('div', 'ed-phead', `${meta.sym} 目标 ${ti + 1} — ${meta.label}`));
    p.appendChild(this._elevLine(t.x, t.z, t.alt));
    p.appendChild(this._row('高度 m', this._numInput(t.alt, 30, 12000, 50, v => t.alt = v, `ed-t${ti}-alt`)));
    p.appendChild(this._row('速度 m/s', this._numInput(t.speed, 60, 550, 10, v => t.speed = v, `ed-t${ti}-speed`)));
    if (t.type === 'launcher') {
      p.appendChild(this._row('弹种', this._selInput(
        [['alt', 'IR/雷达交替'], ['ir', '红外'], ['radar', '雷达']],
        t.launch?.kind || 'alt', v => (t.launch ??= {}).kind = v, `ed-t${ti}-kind`)));
      p.appendChild(this._row('间隔 s', this._numInput(t.launch?.interval ?? 12, 3, 60, 1, v => (t.launch ??= {}).interval = v, `ed-t${ti}-interval`)));
    }
    if (t.type !== 'fighter') {
      p.appendChild(this._row('尾部行为', this._selInput(
        [['loop', '循环航线'], ['orbit', '末点盘旋']],
        t.tail || 'loop', v => t.tail = v, `ed-t${ti}-tail`)));
      // waypoint list with per-leg overrides
      p.appendChild(el('div', 'ed-psep', `航点 ${t.path.length} 个`));
      t.path.forEach((w, wi) => {
        const row = el('div', 'ed-wprow');
        const wpBad = underground(w.x, w.z, w.alt ?? t.alt);
        row.appendChild(el('span', 'ed-wpi' + (wpBad ? ' bad' : ''), wpBad ? `#${wi + 1}⚠` : `#${wi + 1}`));
        const alt = el('input', 'ed-pnum'); alt.type = 'number'; alt.placeholder = `${Math.round(t.alt)}`;
        alt.name = `ed-t${ti}-wp${wi}-alt`; alt.autocomplete = 'off';
        alt.title = '到此点的高度（空=同目标）';
        if (w.alt !== undefined) alt.value = Math.round(w.alt);
        alt.addEventListener('change', () => { w.alt = alt.value === '' ? undefined : Math.max(30, num(alt.value, t.alt)); this._render(); });
        const spd = el('input', 'ed-pnum'); spd.type = 'number'; spd.placeholder = `${Math.round(t.speed)}`;
        spd.name = `ed-t${ti}-wp${wi}-speed`; spd.autocomplete = 'off';
        spd.title = '此段速度（空=同目标）';
        if (w.speed !== undefined) spd.value = Math.round(w.speed);
        spd.addEventListener('change', () => { w.speed = spd.value === '' ? undefined : Math.max(60, num(spd.value, t.speed)); this._render(); });
        row.appendChild(alt); row.appendChild(spd);
        const del = el('span', 'ed-wpdel', '✕');
        del.addEventListener('click', () => { t.path.splice(wi, 1); this._sel = { kind: 'target', ti: this._sel.ti }; this._renderProps(); this._render(); });
        row.appendChild(del);
        p.appendChild(row);
      });
      p.appendChild(el('div', 'ed-pnote', '航点列：高度 / 此段速度（留空继承目标值）'));
    } else {
      p.appendChild(el('div', 'ed-pnote', 'AI 自主飞行 · 仅使用机炮'));
    }
  }
}
