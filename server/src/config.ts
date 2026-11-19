// All runtime settings. Every external service is optional: when its keys are
// missing the server falls back to a local stand-in (console SMS, fake payments,
// disk storage, logged push), so the whole flow runs on a laptop.

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const env = str('NODE_ENV', 'development');
  const prod = env === 'production';
  const cfg = {
    env,
    prod,
    port: num('PORT', 8080),
    // Render sets RENDER_EXTERNAL_URL for web services
    publicUrl: str('PUBLIC_URL', process.env.RENDER_EXTERNAL_URL || 'http://localhost:8080'),
    // brand shown on the site, in emails and SMS
    brand: str('BRAND_NAME', 'Hitchload'),
    supportEmail: str('SUPPORT_EMAIL', 'support@hitchload.ca'),
    databaseUrl: str('DATABASE_URL', 'postgres://postgres@localhost:5432/poputka'),
    jwtSecret: str('JWT_SECRET', prod ? undefined : 'dev-only-secret-change-me'),
    // 32-byte key, base64. Encrypts SIN/BN at rest.
    dataKey: str('DATA_ENCRYPTION_KEY', prod ? undefined : Buffer.alloc(32, 7).toString('base64')),
    adminPhones: (opt('ADMIN_PHONES') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    corsOrigins: (opt('CORS_ORIGINS') ?? '*').split(',').map((s) => s.trim()),

    stripe: {
      secretKey: opt('STRIPE_SECRET_KEY'),
      webhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
      publishableKey: opt('STRIPE_PUBLISHABLE_KEY') ?? '',
    },
    twilio: {
      accountSid: opt('TWILIO_ACCOUNT_SID'),
      authToken: opt('TWILIO_AUTH_TOKEN'),
      verifyServiceSid: opt('TWILIO_VERIFY_SERVICE_SID'),
      fromNumber: opt('TWILIO_FROM_NUMBER'),
    },
    expoAccessToken: opt('EXPO_ACCESS_TOKEN'),
    email: {
      // 'resend' or 'postmark'; empty = emails are only logged (development)
      provider: opt('EMAIL_PROVIDER') as 'resend' | 'postmark' | undefined,
      apiKey: opt('EMAIL_API_KEY'),
      from: str('EMAIL_FROM', 'Hitchload <no-reply@hitchload.ca>'),
    },
    webPush: {
      // generate once: npm run vapid
      publicKey: opt('VAPID_PUBLIC_KEY'),
      privateKey: opt('VAPID_PRIVATE_KEY'),
      subject: str('VAPID_SUBJECT', 'mailto:support@hitchload.ca'),
    },
    googleMapsKey: opt('GOOGLE_MAPS_BROWSER_KEY'),
    mapTilesUrl: str('MAP_TILES_URL', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    mapAttribution: str('MAP_ATTRIBUTION', '&copy; OpenStreetMap contributors'),
    storage: {
      // S3 or any S3-compatible store (Cloudflare R2, DigitalOcean Spaces, Backblaze B2)
      bucket: opt('S3_BUCKET'),
      region: str('S3_REGION', 'ca-central-1'),
      endpoint: opt('S3_ENDPOINT'),
      accessKeyId: opt('S3_ACCESS_KEY_ID'),
      secretAccessKey: opt('S3_SECRET_ACCESS_KEY'),
      localDir: str('LOCAL_STORAGE_DIR', './uploads'),
    },

    // Business rules. Percentages are fractions.
    rules: {
      clientFeeRate: num('CLIENT_FEE_RATE', 0.05),
      driverFeeRate: num('DRIVER_FEE_RATE', 0.05),
      insuranceRate: num('INSURANCE_RATE', 0.015),
      insuranceMinCents: num('INSURANCE_MIN_CENTS', 300),
      basicCargoLimitCents: num('BASIC_CARGO_LIMIT_CENTS', 100_000),
      basicInsuredCargoLimitCents: num('BASIC_INSURED_CARGO_LIMIT_CENTS', 500_000),
      proWindowCitySec: num('PRO_WINDOW_CITY_SEC', 150),
      proWindowIntercitySec: num('PRO_WINDOW_INTERCITY_SEC', 1800),
      tripRequestTimeoutSec: num('TRIP_REQUEST_TIMEOUT_SEC', 1800),
      tripDiscount: num('TRIP_DISCOUNT', 0.2),
      // cancellation by the client after a driver confirmed
      cancelEarlyDriverRate: num('CANCEL_EARLY_DRIVER_RATE', 0.05),
      cancelEarlyPlatformRate: num('CANCEL_EARLY_PLATFORM_RATE', 0.05),
      cancelLateDriverRate: num('CANCEL_LATE_DRIVER_RATE', 0.3),
      cancelLatePlatformRate: num('CANCEL_LATE_PLATFORM_RATE', 0.1),
      cancelLateHours: num('CANCEL_LATE_HOURS', 24),
      noShowDriverRate: num('NO_SHOW_DRIVER_RATE', 0.4),
      noShowPlatformRate: num('NO_SHOW_PLATFORM_RATE', 0.1),
      maxDriverDrops30d: num('MAX_DRIVER_DROPS_30D', 3),
      cityRadiusKm: num('CITY_RADIUS_KM', 40),
      stopMatchKm: num('STOP_MATCH_KM', 30),
      avgSpeedKmh: num('AVG_SPEED_KMH', 90),
      roadFactor: num('ROAD_FACTOR', 1.25),
    },
  };
  if (prod) {
    for (const [k, v] of Object.entries({ STRIPE_SECRET_KEY: cfg.stripe.secretKey, STRIPE_WEBHOOK_SECRET: cfg.stripe.webhookSecret })) {
      if (!v) throw new Error(`${k} is required in production`);
    }
    if (Buffer.from(cfg.dataKey, 'base64').length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes, base64');
  }
  return cfg;
}
