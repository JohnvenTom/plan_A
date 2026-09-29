// input.js — keyboard + mouse with edge detection.
// War Thunder mouse-aim needs RELATIVE mouse motion (the aim direction is
// world-anchored, so we accumulate deltas, not absolute position):
//  - pointer locked  -> use movementX/Y (unbounded, cursor hidden by the lock)
//  - not locked      -> fall back to clientX/Y deltas between events
export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseDown = [false, false, false];
    this.mouseJust = [false, false, false];
    this.aimDX = 0;          // accumulated mouse delta this frame (px)
    this.aimDY = 0;
    this.wheelDelta = 0;
    this.pointerLocked = false;
    this._lastX = null;
    this._lastY = null;

    addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.justPressed.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseDown = this.mouseDown.map(() => false); });
    addEventListener('mousedown', e => {
      if (e.button < 3) { this.mouseDown[e.button] = true; this.mouseJust[e.button] = true; }
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

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.justPressed.has(code); }
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
