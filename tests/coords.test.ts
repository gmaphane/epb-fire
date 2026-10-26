import { describe, expect, it } from 'vitest';
import { parseCoordinates, siteDistanceKm, radioDigits } from '../src/core/coords';
import { fmtDms, toUtm30 } from '../src/core/geo';

const P = { lat: 6.8287, lon: -0.8093 };
const ok = (s: string, lat = P.lat, lon = P.lon, tol = 2e-4) => {
  const r = parseCoordinates(s);
  if (!r.ok) throw new Error(`${s}: ${r.error}`);
  expect(Math.abs(r.lat - lat), `${s} lat ${r.lat}`).toBeLessThan(tol);
  expect(Math.abs(r.lon - lon), `${s} lon ${r.lon}`).toBeLessThan(tol);
  return r;
};

describe('coordinate entry (radio relay)', () => {
  it('decimal degrees in common spoken/written forms', () => {
    ok('6.8287, -0.8093');
    ok('6.8287 -0.8093');
    ok('6.8287 N 0.8093 W');
    ok('6.8287N, 0.8093W');
    ok('N6.8287 W0.8093');
    ok('6.8287° N, 0.8093° W');
    ok('0.8093 W, 6.8287 N'); // lon first with letters
  });
  it('applies site default hemisphere (N/W) when none given, and says so', () => {
    const r = ok('6.8287, 0.8093');
    expect(r.assumedHemisphere).toBe(true);
    expect(ok('6.8287 N 0.8093 W').assumedHemisphere).toBe(false);
  });
  it('DMS, including the app’s own read-out format', () => {
    const s = `${fmtDms(P.lat, 'lat')} ${fmtDms(P.lon, 'lon')}`;
    expect(ok(s).format).toBe('dms');
    ok(`6°49'43.3"N 0°48'33.5"W`, 6.82869, -0.80931);
    ok('6 49 43.3 N, 0 48 33.5 W', 6.82869, -0.80931);
    ok('6°49′43.3″N 0°48′33.5″W', 6.82869, -0.80931);
  });
  it('degrees + decimal minutes', () => {
    const r = ok("6°49.722'N 0°48.558'W", 6.8287, -0.8093);
    expect(r.format).toBe('ddm');
    ok('6 49.722 N 0 48.558 W');
  });
  it('PSP data-sheet compact style', () => {
    ok('6°4846.8N, 000°4803.8W', 6.813, -0.801056, 1e-5);
  });
  it('UTM 30N: easting/northing in any order, with or without zone', () => {
    const { e, n } = toUtm30(P.lat, P.lon);
    ok(`30N ${Math.round(e)} ${Math.round(n)}`, P.lat, P.lon, 2e-5);
    ok(`${Math.round(e)} E ${Math.round(n)} N`, P.lat, P.lon, 2e-5);
    ok(`${Math.round(n)} N ${Math.round(e)} E`, P.lat, P.lon, 2e-5);
    ok(`${Math.round(e)}, ${Math.round(n)}`, P.lat, P.lon, 2e-5);
    expect(parseCoordinates(`${Math.round(e)} ${Math.round(n)}`).ok && (parseCoordinates(`${Math.round(e)} ${Math.round(n)}`) as any).format).toBe('utm');
  });
  it('rejects nonsense with a helpful message', () => {
    for (const bad of ['', 'hello', '6.82', '6 75 10 N 0 48 3 W', '95.1, 0.8', '12345678 99']) {
      const r = parseCoordinates(bad);
      expect(r.ok, bad).toBe(false);
    }
  });
  it('flags misheard digits by distance from site', () => {
    expect(siteDistanceKm(6.8287, -0.8093)).toBeLessThan(30); // inside the estate: no warning (threshold 30 km)
    expect(siteDistanceKm(6.8287, 0.8093)).toBeGreaterThan(150); // W heard as E
    expect(radioDigits(742110)).toBe('742 110');
  });
});
