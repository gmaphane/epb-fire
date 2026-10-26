// All tunables in one place (NFR-MNT-02). Override with VITE_* env vars at build time.
const env = import.meta.env as Record<string, string | undefined>;

export const CONFIG = {
  supabaseUrl: env.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY ?? '',
  /** Estate centre and extent (EPBWA compartments, Blocks A–C; from scripts/port_fire_layers.py). */
  center: { lat: 6.8243, lon: -0.9059 } as { lat: number; lon: number },
  /** Offline pack bounding box [south, west, north, east]. */
  packBBox: [6.755, -1.048, 6.893, -0.764] as [number, number, number, number], // ≈ 1 840 tiles at z12–16
  packZoom: { min: 12, max: 16 },
  packMaxTiles: 4000,
  /** DEV-ONLY tile sources. Replace with licensed/self-hosted tiles before pilot (see docs/05 §7). */
  tiles: {
    street: env.VITE_TILE_STREET ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    satellite:
      env.VITE_TILE_SATELLITE ??
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  },
  gps: {
    goodAccuracyM: 10,
    fairAccuracyM: 20,
    perimeterMaxAccuracyM: 15,
    perimeterMinDistanceM: 5,
    perimeterMinSeconds: 5,
    bestWindowMs: 10_000,
    staleMs: 60_000,
  },
  sync: { tickMs: 10_000, pullMs: 30_000, batch: 50, backoffMaxMs: 60_000 },
  /** Current weather (Open-Meteo). Free endpoint is for evaluation/non-commercial use; set VITE_OPEN_METEO_KEY for the paid one. */
  weather: {
    url: env.VITE_WEATHER_URL ?? 'https://api.open-meteo.com/v1/forecast',
    paidUrl: 'https://customer-api.open-meteo.com/v1/forecast',
    apiKey: env.VITE_OPEN_METEO_KEY ?? '',
  },
  duplicateRadiusM: 500,
  ackEscalationMs: 3 * 60_000,
  walkSpeedKmh: 4,
  driveSpeedKmh: 25,
  version: '0.1.0-mvp',
};

export const IS_DEMO = !CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey;
