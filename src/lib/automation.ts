export type AutomationEvent =
  | "analytics.sync.completed"
  | "analytics.sync.failed"
  | "report.draft.created"
  | "report.approved"
  | "report.export.completed";

export type AutomationEnvelope = {
  event: AutomationEvent;
  occurredAt: string;
  clientId: string;
  reportId?: string;
  payload: Record<string, unknown>;
};

export function createAutomationEnvelope(event: AutomationEvent, clientId: string, payload: Record<string, unknown>): AutomationEnvelope {
  return { event, clientId, payload, occurredAt: new Date().toISOString() };
}
