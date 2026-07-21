const requiredInProduction = ["DATABASE_URL", "NEXTAUTH_SECRET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"] as const;

export function getRuntimeConfiguration() {
  const missing = process.env.NODE_ENV === "production"
    ? requiredInProduction.filter((name) => !process.env[name])
    : [];

  return {
    configured: missing.length === 0,
    missing,
    metaConfigured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI),
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI),
  };
}
