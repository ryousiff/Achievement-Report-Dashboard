import { mediaThumbnailUrl } from "@/lib/media-storage";
import { computeSponsoredAdStatus } from "@/lib/sponsored-ads";

export const sponsoredAdPostSelect = {
  id: true,
  caption: true,
  permalink: true,
  mediaType: true,
  mediaUrl: true,
  thumbnailUrl: true,
  thumbnailStorageKey: true,
  publishedAt: true,
} as const;

type SerializableSponsoredAd = {
  id: string;
  clientId: string;
  socialPostId: string | null;
  title: string | null;
  postUrl: string | null;
  actualSpend: { toString(): string };
  currency: string;
  startDate: Date;
  endDate: Date;
  metaAdAccountId: string | null;
  metaAdId: string | null;
  paidReach: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  createdAt: Date;
  updatedAt: Date;
  socialPost: {
    id: string;
    caption: string | null;
    permalink: string | null;
    mediaType: string;
    mediaUrl: string | null;
    thumbnailUrl: string | null;
    thumbnailStorageKey: string | null;
    publishedAt: Date;
  } | null;
};

/** Shapes a SponsoredAd (with its optional linked SocialPost) for the client, deriving `status`
 * and resolving the post's permanently-stored MinIO thumbnail URL. */
export function serializeSponsoredAd(ad: SerializableSponsoredAd) {
  return {
    id: ad.id,
    clientId: ad.clientId,
    socialPostId: ad.socialPostId,
    title: ad.title,
    postUrl: ad.postUrl,
    actualSpend: Number(ad.actualSpend.toString()),
    currency: ad.currency,
    startDate: ad.startDate.toISOString(),
    endDate: ad.endDate.toISOString(),
    metaAdAccountId: ad.metaAdAccountId,
    metaAdId: ad.metaAdId,
    paidReach: ad.paidReach,
    impressions: ad.impressions,
    clicks: ad.clicks,
    ctr: ad.ctr,
    cpc: ad.cpc,
    cpm: ad.cpm,
    createdAt: ad.createdAt.toISOString(),
    updatedAt: ad.updatedAt.toISOString(),
    status: computeSponsoredAdStatus(ad.startDate, ad.endDate),
    socialPost: ad.socialPost
      ? {
          id: ad.socialPost.id,
          caption: ad.socialPost.caption,
          permalink: ad.socialPost.permalink,
          mediaType: ad.socialPost.mediaType,
          mediaUrl: ad.socialPost.mediaUrl,
          thumbnailUrl: ad.socialPost.thumbnailUrl,
          thumbnailStorageUrl: mediaThumbnailUrl(ad.socialPost.thumbnailStorageKey),
          publishedAt: ad.socialPost.publishedAt.toISOString(),
        }
      : null,
  };
}
