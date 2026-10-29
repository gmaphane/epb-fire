/**
 * Audible + haptic alarm for call-outs (FR-MOB-03) and a short chime for new fires/hotspots.
 *
 * Sound plays through an <audio> element (media channel), with the page's audio session set to
 * "playback" where supported (Safari 17+). That keeps it audible while the ringer is on silent,
 * as long as media volume is up and the app is open. Web Audio is the fallback.
 * When the app is closed, the alert is a system notification and follows the phone's sound settings.
 */
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let alarmEl: HTMLAudioElement | null = null;
let chimeEl: HTMLAudioElement | null = null;
let unlocked = false;

type Tone = [freq: number, start: number, dur: number];
const ALARM: Tone[] = [[880, 0, 0.25], [660, 0.3, 0.25], [880, 0.6, 0.25]];
const CHIME: Tone[] = [[988, 0, 0.18], [740, 0.22, 0.28]];
const LOOP_S = 2.5;

/** 16-bit mono WAV of square tones (soft edges), padded to `total` seconds. */
export function wavBytes(tones: Tone[], total: number): ArrayBuffer {
  const rate = 22050, n = Math.round(rate * total);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let s = 0;
    for (const [f, st, d] of tones) {
      if (t < st || t > st + d) continue;
      const env = Math.min(1, (t - st) / 0.01, (st + d - t) / 0.02);
      s += (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1) * 0.6 * env;
    }
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), true);
  }
  return buf;
}
const wavUrl = (tones: Tone[], total: number) => URL.createObjectURL(new Blob([wavBytes(tones, total)], { type: 'audio/wav' }));

function makeEls() {
  if (alarmEl || typeof Audio === 'undefined') return;
  try {
    alarmEl = new Audio(wavUrl(ALARM, LOOP_S));
    alarmEl.loop = true;
    alarmEl.preload = 'auto';
    chimeEl = new Audio(wavUrl(CHIME, 0.6));
    chimeEl.preload = 'auto';
  } catch {
    alarmEl = chimeEl = null;
  }
}

/** Runs on the first tap: unlocks audio so later alerts can play without a tap. */
export function unlockAudio() {
  try {
    const as = (navigator as any).audioSession;
    if (as && as.type !== 'playback') as.type = 'playback'; // iOS: play through the silent switch
  } catch { /* unsupported */ }
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch { /* no Web Audio */ }
  if (unlocked) return;
  makeEls();
  for (const el of [alarmEl, chimeEl]) {
    if (!el) continue;
    el.muted = true;
    el.play()
      .then(() => { if (el === alarmEl && timer) { el.muted = false; return; } el.pause(); el.currentTime = 0; el.muted = false; unlocked = true; })
      .catch(() => { el.muted = false; });
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

const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* ignore */ } };
const PATTERN = [300, 150, 300, 150, 600];

/** Play an element from the start; false if the browser blocked it. */
async function play(el: HTMLAudioElement | null): Promise<boolean> {
  if (!el) return false;
  try {
    el.muted = false;
    el.volume = 1;
    el.currentTime = 0;
    await el.play();
    return true;
  } catch {
    return false;
  }
}

export function startAlarm() {
  if (timer) return;
  unlockAudio();
  makeEls();
  buzz(PATTERN);
  timer = setInterval(() => buzz(PATTERN), LOOP_S * 1000);
  void play(alarmEl).then((ok) => {
    if (ok || !timer) return;
    const pulse = () => ALARM.forEach(([f, s, d]) => beep(f, s, d)); // fallback
    pulse();
    clearInterval(timer);
    timer = setInterval(() => { pulse(); buzz(PATTERN); }, LOOP_S * 1000);
  });
}
export function stopAlarm() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  try { alarmEl?.pause(); } catch { /* ignore */ }
  buzz(0);
}
export const alarmOn = () => timer !== null;

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAudio, { once: true, passive: true });
}

/** One short two-tone chime + buzz for a new fire or hotspot (not repeating, unlike a call-out). */
export function chime() {
  unlockAudio();
  makeEls();
  buzz([200, 100, 200]);
  void play(chimeEl).then((ok) => { if (!ok) CHIME.forEach(([f, s, d]) => beep(f, s, d)); });
}
