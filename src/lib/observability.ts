export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event, message, ...fields }));
}
