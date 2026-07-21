export type ReportBlockType = "text" | "kpi" | "chart" | "platformAnalytics" | "media" | "notes" | "recommendations";

export type ReportTemplateBlock = {
  type: ReportBlockType;
  title: string;
  content: Record<string, unknown>;
};

export const standardMonthlyTemplate: ReportTemplateBlock[] = [
  { type: "text", title: "ملخص الشهر", content: { body: "" } },
  { type: "platformAnalytics", title: "أداء إنستغرام", content: { platform: "instagram" } },
  { type: "media", title: "أفضل المحتوى", content: { items: [] } },
  { type: "notes", title: "ملاحظات وتوصيات", content: { body: "" } },
];

export function createReportDraft(template: "standard" | "blank") {
  return {
    status: "NEEDS_REVIEW" as const,
    isBlank: template === "blank",
    blocks: template === "standard" ? standardMonthlyTemplate : [],
  };
}
