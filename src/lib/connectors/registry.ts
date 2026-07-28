import { Platform } from "@prisma/client";
import { metaConnector } from "./meta";
import { tiktokConnector } from "./tiktok";
import { linkedInConnector } from "./linkedin";
import { youtubeConnector } from "./youtube";
import { xConnector } from "./x";
import type { SocialConnector } from "./types";

const registry: Record<string, SocialConnector> = {
  meta: metaConnector,
  tiktok: tiktokConnector,
  linkedin: linkedInConnector,
  youtube: youtubeConnector,
  x: xConnector,
};

export function getConnector(provider: string): SocialConnector | undefined {
  return registry[provider.toLowerCase()];
}

export function getConnectorForPlatform(platform: Platform): SocialConnector | undefined {
  return Object.values(registry).find((connector) => connector.supportedPlatforms.includes(platform));
}

export function listConnectors(): SocialConnector[] {
  return Object.values(registry);
}

export function listImplementedConnectors(): SocialConnector[] {
  return listConnectors().filter((connector) => connector.isImplemented && connector.isConfigured());
}
