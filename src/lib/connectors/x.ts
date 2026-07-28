import { Platform } from "@prisma/client";
import { createStubConnector } from "./_stub";

export const xConnector = createStubConnector("X", [Platform.X], [
  "X_CLIENT_ID",
  "X_CLIENT_SECRET",
  "X_REDIRECT_URI",
]);
