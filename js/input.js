// input.js — keyboard + mouse state with edge detection
// War Thunder style: the mouse position IS the aim director (virtual instructor),
// LMB fires guns, RMB fires missiles, wheel trims throttle.
export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.mouseDown = [false, false, false];
    this.mouseJust = [false, false, false];
    // aim point in NDC (-1..1), starts centered -> level flight
    this.aimX = 0;
    this.aimY = 0;
    this.wheelDelta = 0;

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
      this.aimX = (e.clientX / innerWidth) * 2 - 1;
      this.aimY = -((e.clientY / innerHeight) * 2 - 1);
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
  }
}
