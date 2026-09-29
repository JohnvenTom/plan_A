// input.js — rebindable action-based input (keyboard + mouse buttons),
// persisted to localStorage. The mouse stays delta-driven for aiming; wheel
// is fixed to throttle. Bindings use e.code ('KeyW', 'ShiftLeft', ...) or
// 'Mouse0'/'Mouse1'/'Mouse2' for left/middle/right buttons.
export const DEFAULT_BINDINGS = {
  pitchPush: 'KeyW',       // 推杆俯冲
  pitchPull: 'KeyS',       // 拉杆爬升
  rollLeft: 'KeyA',
  rollRight: 'KeyD',
  rudderLeft: 'KeyQ',
  rudderRight: 'KeyE',
  throttleUp: 'ShiftLeft',
  throttleDown: 'ControlLeft',
  fireGun: 'Mouse0',
  fireMissile: 'Mouse2',
  flares: 'Mouse1',        // 干扰弹(热诱弹/箔条自动识别)默认鼠标中键
  cycleMissile: 'KeyR',    // 切换红外弹/雷达弹
  cycleTarget: 'KeyX',     // 切换锁定目标
  freeLook: 'KeyC',        // 长按自由视角(鼠标环视)
  camera: 'KeyV',          // 切换视角档位
  zoom: 'KeyZ',            // 放大
  pause: 'KeyP',
};

export const ACTION_LABELS = {
  pitchPush: '推杆(俯冲)', pitchPull: '拉杆(爬升)',
  rollLeft: '左滚转', rollRight: '右滚转',
  rudderLeft: '左方向舵', rudderRight: '右方向舵',
  throttleUp: '油门+', throttleDown: '油门-',
  fireGun: '机炮', fireMissile: '导弹', flares: '干扰弹(诱弹/箔条)',
  cycleMissile: '切换弹种(红外/雷达)', cycleTarget: '切换锁定目标',
  freeLook: '自由视角(长按)', camera: '切换视角档位', zoom: '放大',
  pause: '暂停',
};

const STORE_KEY = 'skybaro_bindings';

export function codeLabel(code) {
  if (!code) return '—';
  if (code === 'Mouse0') return '鼠标左键';
  if (code === 'Mouse1') return '鼠标中键';
  if (code === 'Mouse2') return '鼠标右键';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ShiftLeft') return '左Shift';
  if (code === 'ShiftRight') return '右Shift';
  if (code === 'ControlLeft') return '左Ctrl';
  if (code === 'ControlRight') return '右Ctrl';
  if (code === 'Space') return '空格';
  return code;
}

export class Input {
  constructor() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this._load();

    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseDown = [false, false, false];
    this.mouseJust = [false, false, false];
    this.aimDX = 0;
    this.aimDY = 0;
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this._lastX = null;
    this._lastY = null;
    this._capturing = null;      // action name while awaiting a rebind press
    this._captureCb = null;

    addEventListener('keydown', e => {
      if (e.repeat) return;
      if (this._capturing) { this._finishCapture(e.code); e.preventDefault(); return; }
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseDown = this.mouseDown.map(() => false); });
    addEventListener('mousedown', e => {
      if (e.button < 3) {
        if (this._capturing) { this._finishCapture('Mouse' + e.button); e.preventDefault(); return; }
        this.mouseDown[e.button] = true;
        this.mouseJust[e.button] = true;
        if (e.button === 1) e.preventDefault();   // middle: no autoscroll
      }
    });
    addEventListener('mouseup', e => { if (e.button < 3) this.mouseDown[e.button] = false; });
    addEventListener('mousemove', e => {
      if (this.pointerLocked) {
        this.aimDX += e.movementX || 0;
        this.aimDY += e.movementY || 0;
      } else {
        if (this._lastX !== null) {
          this.aimDX += e.clientX - this._lastX;
          this.aimDY += e.clientY - this._lastY;
        }
        this._lastX = e.clientX;
        this._lastY = e.clientY;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = !!document.pointerLockElement;
      if (!this.pointerLocked) { this._lastX = null; this._lastY = null; }
    });
    addEventListener('wheel', e => {
      this.wheelDelta -= Math.sign(e.deltaY);   // scroll up = throttle up
      e.preventDefault();
    }, { passive: false });
    addEventListener('contextmenu', e => e.preventDefault());
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(this.bindings, JSON.parse(raw));
    } catch (_) { /* fresh profile */ }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.bindings)); } catch (_) {}
  }

  resetDefaults() {
    this.bindings = { ...DEFAULT_BINDINGS };
    this.save();
  }

  setBinding(action, code) {
    // steal: remove the binding from any other action that holds it
    for (const a of Object.keys(this.bindings)) {
      if (this.bindings[a] === code && a !== action) this.bindings[a] = null;
    }
    this.bindings[action] = code;
    this.save();
  }

  // begin rebind capture; cb(action, code) fires on the next key/mouse press
  startCapture(action, cb) {
    this._capturing = action;
    this._captureCb = cb;
  }

  cancelCapture() {
    this._capturing = null;
    this._captureCb = null;
  }

  _finishCapture(code) {
    const cb = this._captureCb;
    const action = this._capturing;
    this.cancelCapture();
    if (action && cb) cb(action, code);
  }

  // --- action queries ---
  down(action) {
    const code = this.bindings[action];
    if (!code) return false;
    return code.startsWith('Mouse') ? this.mouseDown[+code.slice(5)] : this.keys.has(code);
  }

  pressed(action) {
    const code = this.bindings[action];
    if (!code) return false;
    return code.startsWith('Mouse') ? this.mouseJust[+code.slice(5)] : this.justPressed.has(code);
  }

  // raw e.code passthrough for fixed UI keys (Enter, Escape)
  pressedRaw(code) { return this.justPressed.has(code); }

  mouse(btn) { return this.mouseDown[btn]; }
  mousePressed(btn) { return this.mouseJust[btn]; }

  // call once at the END of each frame
  endFrame() {
    this.justPressed.clear();
    this.mouseJust = this.mouseJust.map(() => false);
    this.wheelDelta = 0;
    this.aimDX = 0;
    this.aimDY = 0;
  }
}
