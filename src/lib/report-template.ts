export type ReportBlockType = "text" | "kpi" | "chart" | "platformAnalytics" | "media" | "notes" | "recommendations";

export type ReportTemplateBlock = {
  type: ReportBlockType;
  title: string;
  content: Record<string, unknown>;
};

export const standardMonthlyTemplate: ReportTemplateBlock[] = [
  { type: "text", title: "غلاف التقرير", content: { body: "تقرير الإنجاز الشهري", page: "cover" } },
  { type: "kpi", title: "أهم الإحصائيات", content: { body: "الوصول والمشاهدات ومعدل التفاعل والمتابعون الجدد وعدد المنشورات.", kpis: [] } },
  { type: "kpi", title: "التفاعل مع المحتوى", content: { body: "إجمالي التفاعل والإعجابات والتعليقات والحفظ والمشاركات وإعادة النشر.", kpis: [] } },
  { type: "chart", title: "معدل اكتساب المتابعين اليومي", content: { body: "أضيفي اتجاه نمو المتابعين اليومي وملاحظتك التحليلية.", chart: "followerGrowth" } },
  { type: "media", title: "أعلى المنشورات من حيث اكتساب المتابعين", content: { body: "اختاري المنشور الذي حقق أعلى اكتساب للمتابعين وأضيفي أبرز ملاحظاته.", items: [] } },
  { type: "chart", title: "نسب التفاعل من حيث المنشور", content: { body: "قارني مساهمة الريلز والمنشورات والقصص والفيديوهات في التفاعل.", chart: "engagementByFormat" } },
  { type: "media", title: "أعلى المنشورات من حيث التفاعل", content: { body: "أضيفي المنشورات الأعلى تفاعلاً مع تفاصيل الإعجابات والتعليقات والحفظ والمشاركة.", items: [] } },
  { type: "media", title: "أعلى المنشورات من حيث المشاهدات", content: { body: "أضيفي المنشورات الأعلى مشاهدة خلال فترة التحليل.", items: [] } },
  { type: "media", title: "محتوى الشهر", content: { body: "لخّصي محتوى الشهر وأبرزي النماذج المرئية والمحتوى الأفضل أداءً.", items: [] } },
  { type: "recommendations", title: "التوصيات", content: { body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم." } },
  { type: "text", title: "شكراً على ثقتكم", content: { body: "Kaan Creative", layout: "closing" } },
];

export function createReportDraft(template: "standard" | "blank") {
  return {
    status: "NEEDS_REVIEW" as const,
    isBlank: template === "blank",
    blocks: template === "standard" ? standardMonthlyTemplate : [],
  };
}
