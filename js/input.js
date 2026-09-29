// input.js — keyboard + mouse state with edge detection
export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseDown = [false, false, false];
    this.mouseJust = [false, false, false];

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
  }
}
