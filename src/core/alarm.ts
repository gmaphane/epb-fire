/** Audible + haptic alarm for new assignments (FR-MOB-03). Needs one prior tap to unlock audio on mobile. */
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* no audio */
  }
}

function beep(freq: number, start: number, dur: number) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
  g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + start);
  o.stop(ctx.currentTime + start + dur + 0.05);
}

function pulse() {
  beep(880, 0, 0.25);
  beep(660, 0.3, 0.25);
  beep(880, 0.6, 0.25);
  try {
    navigator.vibrate?.([300, 150, 300, 150, 600]);
  } catch {
    /* ignore */
  }
}

export function startAlarm() {
  if (timer) return;
  pulse();
  timer = setInterval(pulse, 4000);
}
export function stopAlarm() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}
export const alarmOn = () => timer !== null;

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
}

/** One short two-tone chime + buzz for a new fire or hotspot (not repeating, unlike a call-out). */
export function chime() {
  unlockAudio();
  beep(988, 0, 0.18);
  beep(740, 0.22, 0.28);
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    /* ignore */
  }
}
