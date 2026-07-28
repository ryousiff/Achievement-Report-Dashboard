const requiredInProduction = ["DATABASE_URL", "NEXTAUTH_SECRET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"] as const;

function allSet(...names: string[]) {
  return names.every((name) => Boolean(process.env[name]));
}

export function getRuntimeConfiguration() {
  const missing = process.env.NODE_ENV === "production"
    ? requiredInProduction.filter((name) => !process.env[name])
    : [];

  return {
    configured: missing.length === 0,
    missing,
    metaConfigured: allSet("META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_TOKEN_ENCRYPTION_KEY"),
    googleConfigured: allSet("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"),
    tiktokConfigured: allSet("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"),
    linkedinConfigured: allSet("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI"),
    youtubeConfigured: allSet("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REDIRECT_URI"),
    xConfigured: allSet("X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI"),
    providers: {
      meta: allSet("META_APP_ID", "META_APP_SECRET", "META_REDIRECT_URI", "META_TOKEN_ENCRYPTION_KEY"),
      tiktok: allSet("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REDIRECT_URI"),
      linkedin: allSet("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_REDIRECT_URI"),
      youtube: allSet("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REDIRECT_URI"),
      x: allSet("X_CLIENT_ID", "X_CLIENT_SECRET", "X_REDIRECT_URI"),
    },
  };
}
