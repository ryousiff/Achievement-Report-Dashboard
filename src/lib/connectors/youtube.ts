import { Platform } from "@prisma/client";
import { createStubConnector } from "./_stub";

export const youtubeConnector = createStubConnector("YouTube", [Platform.YOUTUBE], [
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REDIRECT_URI",
]);
