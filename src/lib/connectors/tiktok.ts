import { Platform } from "@prisma/client";
import { createStubConnector } from "./_stub";

export const tiktokConnector = createStubConnector("TikTok", [Platform.TIKTOK], [
  "TIKTOK_CLIENT_KEY",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_REDIRECT_URI",
]);
