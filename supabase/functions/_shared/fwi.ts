// Canadian Forest Fire Weather Index (FWI) System, Van Wagner (1987), as in the cffdrs reference code.
// Daily, from noon (12:00 local) temperature °C, relative humidity %, wind km/h and the 24 h rain to noon (mm).
// The fuel moisture codes carry over from day to day, so the index reflects weeks of drying, not just today.
// Day-length factors for the tropics (latitude 15°N–15°S): DMC 9 h, DC 1.4 (cffdrs latitude adjustment).

export interface FwiDay { ffmc: number; dmc: number; dc: number; isi: number; bui: number; fwi: number }
export const START = { ffmc: 85, dmc: 6, dc: 15 };

export function ffmc(t: number, h: number, w: number, ro: number, fo: number): number {
  h = Math.min(100, Math.max(0, h));
  let mo = (147.2 * (101 - fo)) / (59.5 + fo);
  if (ro > 0.5) {
    const rf = ro - 0.5;
    const add = 42.5 * rf * Math.exp(-100 / (251 - mo)) * (1 - Math.exp(-6.93 / rf));
    mo = mo > 150 ? mo + add + 0.0015 * (mo - 150) ** 2 * Math.sqrt(rf) : mo + add;
    mo = Math.min(mo, 250);
  }
  const ed = 0.942 * h ** 0.679 + 11 * Math.exp((h - 100) / 10) + 0.18 * (21.1 - t) * (1 - Math.exp(-0.115 * h));
  let m: number;
  if (mo > ed) {
    const ko = 0.424 * (1 - (h / 100) ** 1.7) + 0.0694 * Math.sqrt(w) * (1 - (h / 100) ** 8);
    const kd = ko * 0.581 * Math.exp(0.0365 * t);
    m = ed + (mo - ed) * 10 ** -kd;
  } else {
    const ew = 0.618 * h ** 0.753 + 10 * Math.exp((h - 100) / 10) + 0.18 * (21.1 - t) * (1 - Math.exp(-0.115 * h));
    if (mo < ew) {
      const k1 = 0.424 * (1 - ((100 - h) / 100) ** 1.7) + 0.0694 * Math.sqrt(w) * (1 - ((100 - h) / 100) ** 8);
      const kw = k1 * 0.581 * Math.exp(0.0365 * t);
      m = ew - (ew - mo) * 10 ** -kw;
    } else m = mo;
  }
  return Math.min(101, Math.max(0, (59.5 * (250 - m)) / (147.2 + m)));
}

export function dmc(t: number, h: number, ro: number, po: number, le = 9): number {
  t = Math.max(t, -1.1);
  const rk = 1.894 * (t + 1.1) * (100 - h) * le * 1e-4;
  let pr = po;
  if (ro > 1.5) {
    const re = 0.92 * ro - 1.27;
    const mo = 20 + Math.exp(5.6348 - po / 43.43);
    const b = po <= 33 ? 100 / (0.5 + 0.3 * po) : po <= 65 ? 14 - 1.3 * Math.log(po) : 6.2 * Math.log(po) - 17.2;
    const mr = mo + (1000 * re) / (48.77 + b * re);
    pr = Math.max(0, 244.72 - 43.43 * Math.log(mr - 20));
  }
  return Math.max(0, pr + rk);
}

export function dc(t: number, ro: number, d0: number, lf = 1.4): number {
  t = Math.max(t, -2.8);
  const pe = Math.max(0, (0.36 * (t + 2.8) + lf) / 2);
  let dr = d0;
  if (ro > 2.8) {
    const rd = 0.83 * ro - 1.27;
    const qr = 800 * Math.exp(-d0 / 400) + 3.937 * rd;
    dr = Math.max(0, 400 * Math.log(800 / qr));
  }
  return Math.max(0, dr + pe);
}

export function isi(w: number, f: number): number {
  const fm = (147.2 * (101 - f)) / (59.5 + f);
  const sf = 91.9 * Math.exp(-0.1386 * fm) * (1 + fm ** 5.31 / 4.93e7);
  return 0.208 * Math.exp(0.05039 * w) * sf;
}

export function bui(p: number, d: number): number {
  if (p <= 0 && d <= 0) return 0;
  const u = p <= 0.4 * d ? (0.8 * p * d) / (p + 0.4 * d) : p - (1 - (0.8 * d) / (p + 0.4 * d)) * (0.92 + (0.0114 * p) ** 1.7);
  return Math.max(0, u);
}

export function fwi(r: number, u: number): number {
  const fd = u <= 80 ? 0.626 * u ** 0.809 + 2 : 1000 / (25 + 108.64 * Math.exp(-0.023 * u));
  const b = 0.1 * r * fd;
  return b > 1 ? Math.exp(2.72 * (0.434 * Math.log(b)) ** 0.647) : b;
}

/** Run the system over consecutive days (oldest first). */
export function series(days: { t: number; h: number; w: number; rain: number }[], start = START): FwiDay[] {
  let { ffmc: f, dmc: p, dc: d } = start;
  return days.map((x) => {
    f = ffmc(x.t, x.h, x.w, x.rain, f);
    p = dmc(x.t, x.h, x.rain, p);
    d = dc(x.t, x.rain, d);
    const i = isi(x.w, f), u = bui(p, d);
    return { ffmc: f, dmc: p, dc: d, isi: i, bui: u, fwi: fwi(i, u) };
  });
}

/** Danger class from FWI (European Forest Fire Information System classes; provisional for the estate). */
export const LEVELS = ['low', 'moderate', 'high', 'very_high', 'extreme'] as const;
export const levelOfFwi = (v: number) => (v < 11.2 ? 0 : v < 21.3 ? 1 : v < 38 ? 2 : v < 50 ? 3 : 4);
