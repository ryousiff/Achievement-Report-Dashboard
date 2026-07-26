import { decryptToken } from "./token-encryption";

const graphUrl = "https://graph.facebook.com/v23.0";

export type InstagramMedia = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number };
export type InstagramInsight = { name?: string; values?: Array<{ value?: number }> };

export function extractInstagramShortcode(rawUrl: string) {
  let url = rawUrl.trim();
  try { url = decodeURIComponent(url); } catch { /* keep original */ }
  const patterns = [
    /instagram\.com\/p\/([^/?#\s]+)/i,
    /instagram\.com\/reel\/([^/?#\s]+)/i,
    /instagram\.com\/reels\/([^/?#\s]+)/i,
    /instagram\.com\/tv\/([^/?#\s]+)/i,
    /ig\.me\/p\/([^/?#\s]+)/i,
    /instagram\.com\/share\/[^/?#]*\?[^#]*url=([^/?#\s&]+)/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) {
      let shortcode = match[1].trim();
      try { shortcode = decodeURIComponent(shortcode); } catch { /* keep as-is */ }
      return shortcode;
    }
  }
  return null;
}

async function graph<T>(path: string, token: string, parameters: Record<string, string>) {
  const apiUrl = new URL(`${graphUrl}/${path}`);
  Object.entries({ ...parameters, access_token: token }).forEach(([key, value]) => apiUrl.searchParams.set(key, value));
  const response = await fetch(apiUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Meta request failed with status ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function resolveInstagramUrl(clientId: string, getConnection: () => Promise<{ id: string; externalAccountId: string; encryptedToken: string } | null>) {
  const connection = await getConnection();
  if (!connection) throw new Error("Instagram account is not connected for this client.");
  return { resolve: async (url: string) => {
    const shortcode = extractInstagramShortcode(url);
    if (!shortcode) {
      console.error("INVALID INSTAGRAM URL:", url);
      throw new Error(`Invalid Instagram URL: ${url.slice(0, 80)}`);
    }
    const token = decryptToken(connection.encryptedToken);
    let item: InstagramMedia | undefined;
    let oembedInfo: { media_id?: string; thumbnail_url?: string; title?: string; author_name?: string } | undefined;

    // First try oEmbed to get the media_id directly (works for public posts of any age).
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (appId && appSecret) {
      try {
        const oembedUrl = new URL(`${graphUrl}/instagram_oembed`);
        oembedUrl.searchParams.set("url", url);
        oembedUrl.searchParams.set("access_token", `${appId}|${appSecret}`);
        const oembedResponse = await fetch(oembedUrl, { cache: "no-store" });
        if (oembedResponse.ok) {
          oembedInfo = await oembedResponse.json() as { media_id?: string; thumbnail_url?: string; title?: string; author_name?: string };
          if (oembedInfo.media_id) {
            try {
              const media = await graph<InstagramMedia>(oembedInfo.media_id, token, { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count" });
              if (media.id) item = { ...media, thumbnail_url: media.thumbnail_url ?? oembedInfo.thumbnail_url, caption: media.caption ?? oembedInfo.title };
            } catch (mediaError) {
              console.warn("MEDIA FETCH FAILED (collab/external post):", mediaError instanceof Error ? mediaError.message : mediaError);
            }
          }
        }
      } catch (error) {
        console.error("OEMBED FALLBACK FAILED:", error instanceof Error ? error.message : error);
      }
    }

    // Fallback: paginate through the account media.
    if (!item) {
      let cursor: string | undefined;
      let pages = 0;
      const maxPages = 20;
      do {
        pages += 1;
        const parameters: Record<string, string> = { fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count", limit: "100" };
        if (cursor) parameters.after = cursor;
        const media = await graph<{ data?: InstagramMedia[]; paging?: { cursors?: { after?: string } } }>(`${connection.externalAccountId}/media`, token, parameters);
        item = (media.data ?? []).find((post) => post.permalink?.includes(shortcode) || post.id === shortcode);
        cursor = media.paging?.cursors?.after;
      } while (!item && cursor && pages < maxPages);
    }

    // If the post exists on the connected account, return it with full metrics.
    if (item) {
      let metrics: Record<string, number> = { likes: item.like_count ?? 0, comments: item.comments_count ?? 0 };
      try {
        const insights = await graph<{ data?: InstagramInsight[] }>(`${item.id}/insights`, token, { metric: "views,reach,saved,shares,total_interactions,follows" });
        Object.assign(metrics, Object.fromEntries((insights.data ?? []).flatMap((insight) => insight.name && typeof insight.values?.[0]?.value === "number" ? [[insight.name, insight.values[0].value]] : [])));
      } catch {
        // Insights may be unavailable for some media types; keep basic metrics.
      }
      return { id: `instagram-${item.id}`, externalPostId: item.id, caption: item.caption ?? null, mediaType: item.media_type ?? "IMAGE", mediaUrl: item.media_url ?? null, thumbnailUrl: item.thumbnail_url ?? item.media_url ?? null, permalink: item.permalink ?? null, publishedAt: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString(), metrics, score: (metrics.total_interactions ?? 0) + (metrics.shares ?? 0) + (metrics.saved ?? 0) + (metrics.follows ?? 0) };
    }

    // For public collaboration or external posts, build a manual post from oEmbed data.
    if (oembedInfo?.thumbnail_url) {
      return { id: `instagram-${oembedInfo.media_id ?? shortcode}`, externalPostId: oembedInfo.media_id ?? shortcode, caption: oembedInfo.title ?? null, mediaType: "IMAGE", mediaUrl: oembedInfo.thumbnail_url, thumbnailUrl: oembedInfo.thumbnail_url, permalink: url, publishedAt: new Date().toISOString(), metrics: {}, score: 0 };
    }

    console.error("POST NOT FOUND:", { shortcode, clientId, externalAccountId: connection.externalAccountId });
    throw new Error("Post not found. Collaboration or external posts can be imported with manual numbers.");
  } };
}
