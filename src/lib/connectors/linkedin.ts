import { Platform } from "@prisma/client";
import { createStubConnector } from "./_stub";

export const linkedInConnector = createStubConnector("LinkedIn", [Platform.LINKEDIN], [
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "LINKEDIN_REDIRECT_URI",
]);
