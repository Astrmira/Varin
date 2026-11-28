import type { MotionLevel } from '@/lib/motion/preference';
import { createThinkingLight } from './thinking-light';

const clamp = (value: number) => Math.min(1, Math.max(0, value));
export const thinkingInset = (hasOff: boolean) => hasOff ? 0 : 16;

// Positions are continuous stop coordinates (0..1), independent of the model's names.
function brightness(position: number, count: number, hasOff: boolean) {
  if (!hasOff) return .22 + .78 * position;
  if (count === 2) return position;
  const rank = position * (count - 1);
  return rank <= 1 ? rank * .22 : .22 + .78 * (rank - 1) / (count - 2);
}

export function mountThinkingTrack(track: HTMLDivElement, count: number, hasOff: boolean, initial: number, initialMotion: MotionLevel) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  track.prepend(canvas);
  let light = createThinkingLight(canvas);
  let width = 280, height = 30, position = initial, arrived = initial, motion = initialMotion;
  let glide: { from: number; to: number; at: number } | undefined;
  let waveAt = -Infinity, waveX = 0, flow = 3, last = performance.now(), raf = 0;
  let drawnX: number | undefined;
  const inset = thinkingInset(hasOff);
  const center = () => height / 2 + inset + position * (width - height - inset);
  function arrive(target: number, now: number) {
    position = target;
    if (arrived !== target && motion === 'full') { waveAt = now; waveX = center(); }
    arrived = target;
  }
  function paint(now: number) {
    if (glide) {
      const t = clamp((now - glide.at) / 180);
      position = glide.to + (glide.from - glide.to) * (1 - t) ** 3;
      if (t === 1) { arrive(glide.to, now); glide = undefined; }
    }
    const level = track.hasAttribute('data-unreported') ? 0 : brightness(position, count, hasOff);
    const x = center(), full = motion === 'full';
    if (full) flow += Math.max(0, Math.min(.05, (now - last) / 1000)) * (.4 + 3.6 * level ** 1.4);
    last = now;
    if (drawnX !== x) { track.style.setProperty('--thinking-x', x + 'px'); drawnX = x; }
    if (light) light.draw(x, level, flow, full, waveX, Number.isFinite(waveAt) ? (now-waveAt)/1000 : 100);
    else track.style.setProperty('--thinking-energy', String(level));
    if (glide || light && full && level > 0) kick();
  }
  function kick() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(now => { raf = 0; paint(now); });
  }
  function theme() { light?.palette(getComputedStyle(track)); kick(); }
  function resize() {
    width = track.clientWidth || width;
    height = track.clientHeight || height;
    light?.resize(width,height); paint(performance.now());
  }
  function lost() { light?.dispose(); light = null; canvas.hidden = true; kick(); }
  function visibility() {
    cancelAnimationFrame(raf); raf = 0; last = performance.now();
    if (!document.hidden) kick();
  }
  canvas.hidden = !light;
  canvas.addEventListener('webglcontextlost', lost);
  document.addEventListener('visibilitychange', visibility);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
  observer?.observe(track);
  const colors = new MutationObserver(theme);
  colors.observe(document.documentElement, { attributes: true, attributeFilter: ['class','style'] });
  theme(); resize();
  return {
    grab(clientX: number) {
      const offset = center() - (clientX - track.getBoundingClientRect().left);
      return Math.abs(offset) <= height / 2 ? offset : 0;
    },
    drag(clientX: number, offset: number) {
      glide = undefined;
      position = clamp((clientX - track.getBoundingClientRect().left + offset - height/2 - inset) / Math.max(1,width-height-inset));
      paint(performance.now());
      return Math.round(position * (count-1));
    },
    settle(target: number) {
      const now = performance.now();
      if (glide?.to === target) return;
      if (motion === 'off' || position === target) { glide = undefined; arrive(target, now); }
      else glide = { from: position, to: target, at: now };
      paint(now);
    },
    setMotion(next: MotionLevel) {
      motion = next;
      if (motion !== 'full') waveAt = -Infinity;
      if (motion === 'off' && glide) { arrive(glide.to, performance.now()); glide = undefined; }
      kick();
    },
    dispose() {
      cancelAnimationFrame(raf); observer?.disconnect(); colors.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('webglcontextlost', lost);
      light?.dispose(); canvas.remove();
    },
  };
}
