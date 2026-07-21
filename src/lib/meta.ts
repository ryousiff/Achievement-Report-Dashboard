const META_AUTHORIZATION_URL = "https://www.facebook.com/v23.0/dialog/oauth";

export function createMetaAuthorizationUrl(state: string) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !redirectUri) throw new Error("Meta OAuth is not configured.");

  const url = new URL(META_AUTHORIZATION_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights");
  return url.toString();
}
