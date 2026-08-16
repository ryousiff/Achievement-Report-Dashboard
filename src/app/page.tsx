"use client";

import { type FormEvent, useEffect, useState } from "react";
import { completedPeriod, type ReportPeriod } from "@/lib/report-period";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CheckCircle2,
  Eye,
  Facebook,
  FileText,
  History,
  Image as ImageIcon,
  Instagram,
  LayoutDashboard,
  Link2,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  StickyNote,
  Trash2,
  Type,
  UserPlus,
  Users,
  X,
} from "lucide-react";

type Language = "AR" | "EN";
type View = "dashboard" | "reports" | "clients" | "accounts" | "settings";
type BlockKind = "text" | "kpi" | "chart" | "media" | "notes";
type Kpi = {
  id: string;
  label: string;
  value: string;
  change?: string;
  display?: MetricPresentation;
  custom?: boolean;
};
type MonthlySummary = {
  achievements: string;
  highlights: string;
  challenges: string;
};
type ChartConfig = {
  type: "line" | "bar";
  metric: string;
  values: string;
  labels?: string;
  insight: string;
};
type MediaPost = {
  id: string;
  externalPostId?: string;
  caption: string | null;
  mediaType: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  permalink: string | null;
  publishedAt: string;
  metrics: Record<string, number>;
  isCollaborative?: boolean;
  score: number;
};
type MetricPresentation = "cards" | "line" | "bar";
type Block = {
  id: number;
  kind: BlockKind;
  title: string;
  body: string;
  page?: "cover" | "closing";
  pageNote?: string;
  presentation?: MetricPresentation;
  summary?: MonthlySummary;
  chart?: ChartConfig;
  chartUnavailable?: boolean;
  unavailableReason?: string;
  mediaItems?: MediaPost[];
  mediaDisplay?: string[];
  kpis?: Kpi[];
};
type WorkspaceClient = {
  id: string;
  name: string;
  logoUrl?: string | null;
  connections?: Array<{
    platform: string;
    displayName: string;
    lastSyncedAt?: string | null;
    lastSuccessfulSyncAt?: string | null;
    lastFailedSyncAt?: string | null;
    lastFailureReason?: string | null;
    tokenExpiresAt?: string | null;
    sourceAccountId?: string | null;
    historicalBackfillStatus?: string;
    historicalBackfillProcessedPosts?: number;
    historicalBackfillLastError?: string | null;
    syncJobs?: Array<{
      status: string;
      type: string;
      attempts: number;
      runAfter: string;
      lastError?: string | null;
    }>;
    syncRuns?: Array<{
      status: string;
      startedAt: string;
      finishedAt?: string | null;
      postsSynced: number;
      durationMs?: number | null;
      errorMessage?: string | null;
    }>;
  }>;
  _count?: { reports: number };
};
type SyncResult = {
  connections: number;
  posts: number;
  joinedExisting: boolean;
  results: Array<{
    connectionId: string;
    displayName: string;
    status: "success" | "failed";
    posts: number;
    durationMs: number;
    error?: string;
  }>;
};
type MetaAccount = {
  id: string;
  platform: "INSTAGRAM" | "FACEBOOK";
  displayName: string;
  lastSyncedAt?: string | null;
  assignments: Array<{ clientId: string }>;
};
type MetaProfile = {
  id: string;
  displayName: string;
  lastSyncedAt?: string | null;
  accounts: MetaAccount[];
};
type WorkspaceUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  features?: string[];
  googleConnected?: boolean;
};
type ReportMetadata = {
  title: string;
  clientId: string | null;
  periodStart: string;
  periodEnd: string;
  periodType: ReportPeriod;
};
type Dictionary = (typeof copy)[Language];
type MediaSort = "score" | "interactions" | "views" | "follows" | "newest";
type CoverageStatus =
  "COMPLETE" | "PARTIAL" | "SYNCING" | "UNAVAILABLE" | "FAILED";
type CoverageState = {
  status: CoverageStatus;
  mediaCoverage: { from: string | null; to: string | null; complete: boolean };
  reachCoverage: { from: string | null; to: string | null; complete: boolean };
  followsCoverage: {
    from: string | null;
    to: string | null;
    complete: boolean;
  };
  postInsightCoverage: { availableMetrics: string[]; missingMetrics: string[] };
  storyCoverage: { status: "NOT_COLLECTED" };
  historicalBackfillStatus: string;
  missingRanges: Array<{ start: string; end: string; reason: string }>;
  warnings: string[];
};

function hasFeature(user: WorkspaceUser | null | undefined, feature: string) {
  return Boolean(user?.features?.includes(feature));
}

function mediaSectionConfig(title: string): {
  display: string[];
  sort: MediaSort;
} {
  const normalized = title.toLowerCase();
  if (
    normalized.includes("اكتساب المتابعين") ||
    normalized.includes("follower acquisition")
  )
    return { display: ["follows"], sort: "follows" };
  if (normalized.includes("المشاهدات") || normalized.includes("by views"))
    return { display: ["views"], sort: "views" };
  if (normalized.includes("التفاعل") || normalized.includes("engagement"))
    return { display: ["total_interactions"], sort: "interactions" };
  return { display: ["total_interactions", "views"], sort: "newest" };
}

function normalizeLegacyMediaDisplay(title: string, value: unknown) {
  const display = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
  const contextualDisplay = mediaSectionConfig(title).display;
  return display?.length === 2 &&
    display.includes("total_interactions") &&
    display.includes("views") &&
    contextualDisplay.length === 1
    ? undefined
    : display;
}

const copy = {
  AR: {
    workspace: "مساحة العمل",
    management: "إدارة",
    dashboard: "الرئيسية",
    reports: "التقارير",
    clients: "العملاء",
    accounts: "الحسابات المتصلة",
    settings: "الإعدادات",
    internalReports: "منصة التقارير الداخلية",
    greeting: "صباح الخير، {name}",
    overview: "هذه نظرة سريعة على تقارير عملائك لهذا الشهر.",
    configuration: "أكملي إعدادات .env لتفعيل التكاملات.",
    blank: "قالب فارغ",
    autoDraft: "إنشاء مسودة تلقائية",
    create: "إنشاء تقرير جديد",
    connectStart: "خطوة واحدة للبدء:",
    connectText:
      "اربطي حساب إنستغرام للعميل الأول للحصول على بيانات محدثة تلقائياً.",
    connectMeta: "ربط Meta",
    activeClients: "عملاء نشطون",
    reviewReports: "تقارير بانتظار المراجعة",
    instagramAccounts: "حسابات إنستغرام متصلة",
    completedReports: "تقارير مكتملة هذا الشهر",
    thisMonth: "+2 هذا الشهر",
    reviewNeeded: "تحتاج إلى مراجعتك",
    lastSync: "آخر مزامنة منذ 12 د",
    compared: "+6 عن الشهر الماضي",
    reach: "نمو الوصول",
    reachDesc: "إجمالي الوصول عبر حسابات إنستغرام المتصلة",
    period: "آخر 30 يوماً",
    connected: "الحسابات المتصلة",
    isolated: "لكل عميل حسابات مستقلة وآمنة",
    manage: "إدارة",
    connect: "ربط",
    connectAccount: "ربط حساب عميل",
    recent: "التقارير الأخيرة",
    recentDesc: "يمكنك المتابعة من حيث توقفتِ أو مراجعة المسودات الآلية.",
    showAll: "عرض الكل",
    needsReview: "بانتظار المراجعة",
    complete: "مكتمل",
    reportTitle: "تقرير أبريل ٫ واحات القرآن",
    saveExit: "حفظ وخروج",
    previewExport: "معاينة وتصدير",
    approve: "اعتماد التقرير",
    assistant: "مساعد التقرير:",
    assistantText:
      "تم تعبئة بيانات إنستغرام وأفضل المحتوى من آخر مزامنة. عدّلي أي قسم قبل الاعتماد.",
    refresh: "تحديث البيانات",
    addReport: "إضافة إلى التقرير",
    addReportDesc: "اختاري أي قسم. يمكنك تحريكه أو حذفه في أي وقت.",
    restore: "استعادة القالب الشهري",
    blankTitle: "هذا قالب فارغ",
    blankText:
      "ابدئي بإضافة أول قسم من القائمة. لديك الحرية الكاملة لتصميم التقرير.",
    editHint: "انقري النص للتعديل",
    saved: "تم حفظ المسودة",
    metaConnected: "تم فتح إعدادات ربط Meta",
    exportReady: "تم تجهيز المعاينة للتصدير",
    approved: "تم اعتماد التقرير",
    refreshed: "تم تحديث بيانات المسودة",
    sectionAdded: "تمت إضافة القسم",
    accountView: "إدارة الحسابات المتصلة",
    comingSoon: "هذه الصفحة ستكون جاهزة مع ربط البيانات الحية.",
    text: "قسم نصي",
    kpi: "بطاقات مؤشرات",
    chart: "رسم بياني",
    media: "صور ومنشورات",
    notes: "ملاحظات وتوصيات",
    monthSummary: "ملخص الشهر",
    instagramPerformance: "أداء إنستغرام",
    topContent: "أفضل المحتوى",
    reportNotes: "ملاحظات وتوصيات",
    editBody: "انقري للتعديل وإضافة تفاصيل هذا القسم في التقرير.",
    monthSummaryBody:
      "لمحة سريعة عن النتائج والأهداف المحققة خلال فترة التقرير.",
    instagramBody: "المتابعون، الوصول، التفاعل وأفضل المحتوى.",
    contentBody: "اختاري المنشورات والصور التي تريدين إبرازها في التقرير.",
    notesBody: "أضيفي ملاحظات الفريق والخطوات المقترحة للشهر القادم.",
    connectedStatus: "متصل",
    disconnected: "غير متصل",
    open: "فتح",
    chooseKpis: "اختيار مؤشرات الأداء",
    chooseKpisDesc: "حددي مؤشرات إنستغرام التي تريدين إظهارها في هذا التقرير.",
    platform: "المنصة",
    instagram: "إنستغرام",
    metrics: "المؤشرات",
    customKpi: "مؤشر مخصص",
    customKpiHint: "أضيفي رقماً من العميل أو من أي نظام آخر.",
    kpiName: "اسم المؤشر",
    kpiValue: "القيمة",
    kpiChange: "التغير",
    addCustom: "إضافة مؤشر مخصص",
    addSelected: "إضافة إلى التقرير",
    cancel: "إلغاء",
    selectedMetrics: "مؤشرات مختارة",
    sampleData: "قيم تجريبية حتى يتم ربط بيانات Meta",
    followers: "المتابعون",
    metricReach: "الوصول",
    metricTotalViews: "إجمالي المشاهدات",
    metricViews: "مشاهدات المنشورات العضوية",
    metricFollows: "المتابعون الجدد",
    metricFollowersLost: "المتابعون المفقودون",
    metricNetFollowerGrowth: "صافي نمو المتابعين",
    metricPosts: "المنشورات",
    metricOwnedPosts: "المنشورات الملكية",
    metricCollabPosts: "المنشورات التعاونية",
    metricInteractions: "إجمالي التفاعل",
    metricLikes: "إعجاب",
    metricComments: "تعليق",
    metricShares: "المشاركات",
    metricSaves: "الحفظ",
    metricMediaFollows: "متابعات من المحتوى",
    metricImpressions: "مرات الظهور",
    metricEngagementRate: "معدل التفاعل",
    metricProfileVisits: "زيارات الملف الشخصي",
    metricLinkClicks: "نقرات الرابط",
    metricReelsPlays: "مشاهدات الريلز",
  },
  EN: {
    workspace: "WORKSPACE",
    management: "MANAGEMENT",
    dashboard: "Dashboard",
    reports: "Reports",
    clients: "Clients",
    accounts: "Connected accounts",
    settings: "Settings",
    internalReports: "Internal reporting platform",
    greeting: "Good morning, {name}",
    overview: "Here is a quick overview of your clients’ reports this month.",
    configuration: "Complete .env setup to enable integrations.",
    blank: "Blank template",
    autoDraft: "Auto-generate draft",
    create: "Create report",
    connectStart: "One step to begin:",
    connectText:
      "Connect the first client Instagram account to receive updated data automatically.",
    connectMeta: "Connect Meta",
    activeClients: "Active clients",
    reviewReports: "Reports to review",
    instagramAccounts: "Connected Instagram accounts",
    completedReports: "Completed this month",
    thisMonth: "+2 this month",
    reviewNeeded: "Needs your review",
    lastSync: "Last synced 12 min ago",
    compared: "+6 from last month",
    reach: "Reach growth",
    reachDesc: "Total reach across connected Instagram accounts",
    period: "Last 30 days",
    connected: "Connected accounts",
    isolated: "Each client has secure, separate accounts",
    manage: "Manage",
    connect: "Connect",
    connectAccount: "Connect client account",
    recent: "Recent reports",
    recentDesc: "Continue where you stopped or review auto-generated drafts.",
    showAll: "View all",
    needsReview: "Needs review",
    complete: "Completed",
    reportTitle: "April report — Wahat Al Quran",
    saveExit: "Save & exit",
    previewExport: "Preview & export",
    approve: "Approve report",
    assistant: "Report assistant:",
    assistantText:
      "Instagram data and top content were filled from the latest sync. Edit every section before approval.",
    refresh: "Refresh data",
    addReport: "Add to report",
    addReportDesc: "Choose any section. You can move or remove it at any time.",
    restore: "Restore monthly template",
    blankTitle: "This is a blank template",
    blankText:
      "Add your first section from the list. You have complete freedom to design this report.",
    editHint: "Click text to edit",
    saved: "Draft saved",
    metaConnected: "Meta connection settings opened",
    exportReady: "Export preview is ready",
    approved: "Report approved",
    refreshed: "Draft data refreshed",
    sectionAdded: "Section added",
    accountView: "Manage connected accounts",
    comingSoon: "This view will be ready with live data connections.",
    text: "Text section",
    kpi: "KPI cards",
    chart: "Chart",
    media: "Photos & posts",
    notes: "Notes & recommendations",
    monthSummary: "Monthly summary",
    instagramPerformance: "Instagram performance",
    topContent: "Top content",
    reportNotes: "Notes & recommendations",
    editBody: "Click to edit and add details to this report section.",
    monthSummaryBody:
      "A quick view of results and goals achieved during this reporting period.",
    instagramBody: "Followers, reach, engagement, and top content.",
    contentBody:
      "Choose the posts and photos you want to feature in this report.",
    notesBody: "Add team notes and suggested next steps for the coming month.",
    connectedStatus: "Connected",
    disconnected: "Not connected",
    open: "Open",
    chooseKpis: "Choose KPI cards",
    chooseKpisDesc: "Select the Instagram metrics to display in this report.",
    platform: "Platform",
    instagram: "Instagram",
    metrics: "Metrics",
    customKpi: "Custom KPI",
    customKpiHint: "Add a number from the client or another system.",
    kpiName: "KPI name",
    kpiValue: "Value",
    kpiChange: "Change",
    addCustom: "Add custom KPI",
    addSelected: "Add to report",
    cancel: "Cancel",
    selectedMetrics: "Selected metrics",
    sampleData: "Sample values until Meta data is connected",
    followers: "Followers",
    metricReach: "Reach",
    metricTotalViews: "Total views",
    metricViews: "Organic post views",
    metricFollows: "Followers gained",
    metricFollowersLost: "Followers lost",
    metricNetFollowerGrowth: "Net follower growth",
    metricPosts: "Posts",
    metricOwnedPosts: "Owned posts",
    metricCollabPosts: "Collaborative posts",
    metricInteractions: "Total interactions",
    metricLikes: "Likes",
    metricComments: "Comments",
    metricShares: "Shares",
    metricSaves: "Saves",
    metricMediaFollows: "Media follows",
    metricImpressions: "Impressions",
    metricEngagementRate: "Engagement rate",
    metricProfileVisits: "Profile visits",
    metricLinkClicks: "Link clicks",
    metricReelsPlays: "Reels plays",
  },
} as const;

const blockIcons = {
  text: Type,
  kpi: BarChart3,
  chart: BarChart3,
  media: ImageIcon,
  notes: StickyNote,
};
const metricValues = {
  followers: ["12,540", "+8.2%"],
  metricReach: ["245,000", "+16.4%"],
  metricTotalViews: ["412,800", "+11.8%"],
  metricViews: ["168,400", "+22.1%"],
  metricFollows: ["1,240", "+8.2%"],
  metricFollowersLost: ["320", "-2.1%"],
  metricNetFollowerGrowth: ["+920", "+6.1%"],
  metricPosts: ["28", "+12.0%"],
  metricOwnedPosts: ["25", "+10.0%"],
  metricCollabPosts: ["3", "+50%"],
  metricInteractions: ["14,210", "+18.3%"],
  metricLikes: ["8,500", "+15.0%"],
  metricComments: ["1,200", "+10.0%"],
  metricShares: ["940", "+19.8%"],
  metricSaves: ["2,760", "+14.2%"],
  metricMediaFollows: ["350", "+5.0%"],
  metricImpressions: ["412,800", "+11.8%"],
  metricEngagementRate: ["5.8%", "+0.7%"],
  metricProfileVisits: ["9,640", "+12.5%"],
  metricLinkClicks: ["1,284", "+9.6%"],
  metricReelsPlays: ["168,400", "+22.1%"],
} as const;
type MetricKey = keyof typeof metricValues;



export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [language, setLanguage] = useState<Language>("AR");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [blank, setBlank] = useState(false);
  const [serviceReady, setServiceReady] = useState<boolean | null>(null);
  const [toast, setToast] = useState("");
  const [generatingReport, setGeneratingReport] = useState(false);
  const [kpiPickerOpen, setKpiPickerOpen] = useState(false);
  const [kpiTargetBlockId, setKpiTargetBlockId] = useState<number | null>(null);
  const [mediaTargetBlockId, setMediaTargetBlockId] = useState<number | null>(
    null,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reportSetupOpen, setReportSetupOpen] = useState(false);
  const [approvalIssues, setApprovalIssues] = useState<string[] | null>(null);
  const [setupTemplate, setSetupTemplate] = useState<"standard" | "blank">(
    "standard",
  );
  const [reportMetadata, setReportMetadata] = useState<ReportMetadata>(() => {
    const period = completedPeriod("monthly");
    return {
      title: "تقرير " + period.label,
      clientId: null,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      periodType: "monthly",
    };
  });
  const [draftId, setDraftId] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<
    "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "EXPORTED"
  >("DRAFT");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "saved" | "failed"
  >("idle");
  const [workspaceClients, setWorkspaceClients] = useState<WorkspaceClient[]>(
    [],
  );
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [user, setUser] = useState<WorkspaceUser | null | undefined>(undefined);
  const t = copy[language];
  const rtl = language === "AR";

  useEffect(() => {
    document.documentElement.lang = rtl ? "ar" : "en";
    document.documentElement.dir = rtl ? "rtl" : "ltr";
  }, [rtl]);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("meta");
    if (!result) return;
    setToast(
      result === "connected"
        ? t.metaConnected
        : rtl
          ? "تعذر إكمال ربط Meta. راجعي رسالة الخطأ في خادم التطبيق ثم أعيدي المحاولة."
          : "Meta connection could not be completed. Review the server error message, then try again.",
    );
    window.history.replaceState({}, "", window.location.pathname);
  }, [t]);
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("google");
    if (!result) return;
    setToast(
      result === "connected"
        ? rtl
          ? "تم ربط حساب Google."
          : "Google account connected."
        : rtl
          ? "تعذر ربط Google. راجعي سجلات الخادم."
          : "Google connection failed. Check server logs.",
    );
    window.history.replaceState({}, "", window.location.pathname);
  }, [t]);
  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((data: { status?: string }) =>
        setServiceReady(data.status === "ok"),
      )
      .catch(() => setServiceReady(false));
  }, []);
  const refreshClients = async () => {
    const response = await fetch("/api/clients");
    if (!response.ok) return;
    const data = (await response.json()) as { clients?: WorkspaceClient[] };
    const clients = data.clients ?? [];
    setWorkspaceClients(clients);
    setSelectedClientId((current) =>
      clients.some((client) => client.id === current)
        ? current
        : (clients[0]?.id ?? null),
    );
  };
  const waitForClientSync = async (
    clientId: string,
    attempt = 0,
  ): Promise<void> => {
    const response = await fetch("/api/clients");
    const data = response.ok
      ? ((await response.json()) as { clients?: WorkspaceClient[] })
      : { clients: [] };
    const client = data.clients?.find((item) => item.id === clientId);
    const active = client?.connections?.some((connection) =>
      connection.syncJobs?.some(
        (job) => job.status === "QUEUED" || job.status === "RUNNING",
      ),
    );
    if (active && attempt < 60) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return waitForClientSync(clientId, attempt + 1);
    }
  };
  const refreshReportData = async () => {
    if (reportStatus === "APPROVED")
      throw new Error(
        "التقرير المعتمد محفوظ كنسخة نهائية. انسخي التقرير للفترة التالية لإجراء التحديثات.",
      );
    if (!reportMetadata.clientId)
      throw new Error("لم يتم اختيار عميل للتقرير.");
    if (!draftId) throw new Error("لم يتم حفظ التقرير بعد.");
    // Queue a sync first so the database has the latest data, then refresh the report server-side.
    const syncResponse = await fetch(
      `/api/clients/${reportMetadata.clientId}/sync`,
      { method: "POST" },
    );
    if (!syncResponse.ok)
      throw new Error(
        "تعذر وضع مزامنة Meta في قائمة الانتظار. تأكدي من اتصال الحساب.",
      );
    if (syncResponse.status === 202)
      await waitForClientSync(reportMetadata.clientId);
    const response = await fetch(`/api/reports/${draftId}/refresh`, {
      method: "POST",
    });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      throw new Error(data.error ?? "تعذر تحديث بيانات التقرير.");
    }
    await loadReport(draftId);
    const now = new Date().toISOString();
    setLastSyncedAt(now);
    return now;
  };
  useEffect(() => {
    fetch("/api/auth/me")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { user?: WorkspaceUser } | null) =>
        setUser(data?.user ?? null),
      )
      .catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (user) void refreshClients();
  }, [user]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const standardBlocks = (): Block[] => {
    const arabic = t.dashboard === "الرئيسية";
    return arabic
      ? [
          {
            id: 1,
            kind: "text",
            title: "غلاف التقرير",
            body: "تقرير الإنجاز الشهري",
            page: "cover",
          },
          {
            id: 2,
            kind: "kpi",
            title: "أهم الإحصائيات",
            body: "الوصول والمشاهدات ومعدل التفاعل والمتابعون الجدد وعدد المنشورات.",
            kpis: [
              { id: "reach", label: "شخص تم الوصول له", value: "0" },
              { id: "views", label: "مشاهدة", value: "0" },
              {
                id: "engagement-rate",
                label: "متوسط التفاعل على أساس الوصول",
                value: "0%",
              },
              { id: "followers", label: "نسبة نمو المتابعين", value: "0%" },
              { id: "posts", label: "منشور", value: "0" },
            ],
          },
          {
            id: 3,
            kind: "kpi",
            title: "التفاعل مع المحتوى",
            body: "إجمالي التفاعل والإعجابات والتعليقات والحفظ والمشاركات وإعادة النشر.",
            kpis: [
              { id: "engagements", label: "التفاعل مع المحتوى", value: "0" },
              { id: "likes", label: "إعجاب", value: "0" },
              { id: "comments", label: "تعليق", value: "0" },
              { id: "saves", label: "حفظ", value: "0" },
              { id: "shares", label: "مشاركة", value: "0" },
              { id: "reposts", label: "إعادة نشر", value: "0" },
            ],
          },
          {
            id: 4,
            kind: "kpi",
            title: "معدل اكتساب المتابعين اليومي",
            body: "بيان اتجاه المتابعين الجدد من بيانات المنصة.",
            kpis: [
              {
                id: "daily-followers",
                label: "المتابعون الجدد",
                value: "107",
                display: "line",
              },
            ],
          },
          {
            id: 5,
            kind: "media",
            title: "أعلى المنشورات من حيث اكتساب المتابعين",
            body: "اختاري المنشور الذي حقق أعلى اكتساب للمتابعين وأضيفي أبرز ملاحظاته.",
          },
          {
            id: 6,
            kind: "kpi",
            title: "نسب التفاعل من حيث المنشور",
            body: "مقارنة أنواع المحتوى من بيانات المنصة.",
            kpis: [
              { id: "reels", label: "الريلز", value: "54", display: "bar" },
              { id: "posts", label: "المنشورات", value: "42", display: "bar" },
              { id: "stories", label: "القصص", value: "4", display: "bar" },
              { id: "videos", label: "الفيديوهات", value: "1", display: "bar" },
            ],
          },
          {
            id: 7,
            kind: "media",
            title: "أعلى المنشورات من حيث التفاعل",
            body: "أضيفي المنشورات الأعلى تفاعلاً مع تفاصيل الإعجابات والتعليقات والحفظ والمشاركة.",
          },
          {
            id: 8,
            kind: "media",
            title: "أعلى المنشورات من حيث المشاهدات",
            body: "أضيفي المنشورات الأعلى مشاهدة خلال فترة التحليل.",
          },
          {
            id: 9,
            kind: "media",
            title: "محتوى الشهر",
            body: "لخّصي محتوى الشهر وأبرزي النماذج المرئية والمحتوى الأفضل أداءً.",
          },
          {
            id: 10,
            kind: "notes",
            title: "التوصيات",
            body: "أضيفي توصيات عملية قابلة للتنفيذ للشهر القادم.",
          },
          {
            id: 11,
            kind: "text",
            title: "شكراً على ثقتكم",
            body: "Kaan Creative",
          },
        ]
      : [
          {
            id: 1,
            kind: "text",
            title: "Report cover",
            body: "Monthly achievement report",
            page: "cover",
          },
          {
            id: 2,
            kind: "kpi",
            title: "Key statistics",
            body: "Reach, views, engagement rate, new followers, and posts.",
            kpis: [
              { id: "reach", label: "Accounts reached", value: "0" },
              { id: "views", label: "Views", value: "0" },
              { id: "engagement-rate", label: "Engagement rate", value: "0%" },
              { id: "followers", label: "Follower growth", value: "0%" },
              { id: "posts", label: "Posts", value: "0" },
            ],
          },
          {
            id: 3,
            kind: "kpi",
            title: "Content engagement",
            body: "Total engagement, likes, comments, saves, shares, and reposts.",
            kpis: [
              { id: "engagements", label: "Content engagement", value: "0" },
              { id: "likes", label: "Likes", value: "0" },
              { id: "comments", label: "Comments", value: "0" },
              { id: "saves", label: "Saves", value: "0" },
              { id: "shares", label: "Shares", value: "0" },
              { id: "reposts", label: "Reposts", value: "0" },
            ],
          },
          {
            id: 4,
            kind: "chart",
            title: "Daily follower growth",
            body: "Add the daily follower-growth trend and an analytical observation.",
          },
          {
            id: 5,
            kind: "media",
            title: "Top posts for follower acquisition",
            body: "Select the post that gained the most followers and add its key insight.",
          },
          {
            id: 6,
            kind: "chart",
            title: "Engagement by content format",
            body: "Compare how reels, posts, stories, and videos contributed to engagement.",
          },
          {
            id: 7,
            kind: "media",
            title: "Top posts by engagement",
            body: "Add the top posts with their engagement breakdown.",
          },
          {
            id: 8,
            kind: "media",
            title: "Top posts by views",
            body: "Add the top viewed posts during the reporting period.",
          },
          {
            id: 9,
            kind: "media",
            title: "Monthly content",
            body: "Summarize the monthly content, visual examples, and best-performing content.",
          },
          {
            id: 10,
            kind: "notes",
            title: "Recommendations",
            body: "Add clear, practical recommendations for the coming month.",
          },
          { id: 11, kind: "text", title: "Thank you", body: "Kaan Creative" },
        ];
  };
  const blocksFromReport = (
    reportBlocks: Array<{ type: string; position: number; content: unknown }>,
  ): Block[] => {
    const typeMap: Record<string, BlockKind> = {
      TEXT: "text",
      KPI: "kpi",
      CHART: "chart",
      PLATFORM_ANALYTICS: "chart",
      MEDIA: "media",
      NOTES: "notes",
      RECOMMENDATIONS: "notes",
    };
    return reportBlocks.map((block) => {
      const content = block.content as Record<string, unknown>;
      return {
        id: block.position + 1,
        kind: typeMap[block.type] ?? "text",
        title: typeof content.title === "string" ? content.title : t.text,
        body: typeof content.body === "string" ? content.body : "",
        page:
          content.page === "cover" || content.page === "closing"
            ? content.page
            : undefined,
        pageNote:
          typeof content.pageNote === "string" ? content.pageNote : undefined,
        presentation:
          content.presentation === "cards" ||
          content.presentation === "line" ||
          content.presentation === "bar"
            ? content.presentation
            : undefined,
        chart:
          content.chart &&
          typeof content.chart === "object" &&
          !Array.isArray(content.chart)
            ? (content.chart as ChartConfig)
            : undefined,
        chartUnavailable: content.chartUnavailable === true,
        unavailableReason:
          typeof content.unavailableReason === "string"
            ? content.unavailableReason
            : undefined,
        mediaItems: Array.isArray(content.mediaItems)
          ? (content.mediaItems as MediaPost[]).filter(
              (item, index, items) =>
                items.findIndex((candidate) => candidate.id === item.id) ===
                index,
            )
          : undefined,
        mediaDisplay: normalizeLegacyMediaDisplay(
          typeof content.title === "string" ? content.title : t.text,
          content.mediaDisplay,
        ),
        summary:
          content.summary &&
          typeof content.summary === "object" &&
          !Array.isArray(content.summary)
            ? (content.summary as MonthlySummary)
            : undefined,
        kpis: Array.isArray(content.kpis) ? (content.kpis as Kpi[]) : undefined,
      };
    });
  };
  const openReportSetup = (template: "standard" | "blank") => {
    const period = completedPeriod("monthly");
    const client = workspaceClients.find(
      (item) => item.id === selectedClientId,
    );
    setReportMetadata({
      title: client
        ? `تقرير ${period.label} — ${client.name}`
        : `تقرير ${period.label}`,
      clientId: selectedClientId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      periodType: "monthly",
    });
    setSetupTemplate(template);
    setReportSetupOpen(true);
  };
  const startTemplate = async (
    template: "standard" | "blank",
    metadata: ReportMetadata,
  ) => {
    setReportStatus("DRAFT");
    setSaveState("idle");
    setGeneratingReport(template === "standard");
    setBlocks([]);
    setBlank(template === "blank");
    setDraftId(null);
    setReportMetadata(metadata);
    setSelectedClientId(metadata.clientId);
    setView("reports");
    if (!metadata.clientId) {
      setGeneratingReport(false);
      return;
    }
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: metadata.clientId,
          template,
          title: metadata.title,
          periodStart: `${metadata.periodStart}T00:00:00.000Z`,
          periodEnd: `${metadata.periodEnd}T23:59:59.999Z`,
        }),
      });
      if (!response.ok) {
        setToast(t.configuration);
        return;
      }
      const data = (await response.json()) as {
        report: {
          id: string;
          blocks: Array<{ type: string; position: number; content: unknown }>;
        };
        syncQueued?: boolean;
      };
      setDraftId(data.report.id);
      setBlocks(blocksFromReport(data.report.blocks));
      setToast(
        template === "standard"
          ? data.syncQueued
            ? "تم إنشاء التقرير ووضعت مزامنة Meta في قائمة الانتظار. حدّثي البيانات بعد اكتمالها."
            : "تم إنشاء التقرير ببيانات الفترة المتاحة."
          : t.blankTitle,
      );
    } finally {
      setGeneratingReport(false);
    }
  };
  const saveDraft = async () => {
    if (reportStatus === "APPROVED") {
      setToast("التقرير المعتمد محفوظ كنسخة نهائية ولا يمكن تعديله.");
      return;
    }
    if (!draftId) {
      setToast(t.saved);
      return;
    }
    setSaveState("saving");
    const persistedBlocks = blocks.map((block) => ({
      type: block.kind,
      title: block.title,
      content: {
        body: block.body,
        page: block.page,
        pageNote: block.pageNote,
        presentation: block.presentation,
        summary: block.summary,
        chart: block.chart,
        chartUnavailable: block.chartUnavailable,
        unavailableReason: block.unavailableReason,
        mediaItems: block.mediaItems ?? [],
        mediaDisplay:
          block.mediaDisplay ?? mediaSectionConfig(block.title).display,
        kpis: block.kpis ?? [],
      },
    }));
    const response = await fetch("/api/reports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: draftId,
        title: reportMetadata.title,
        isBlank: blank,
        blocks: persistedBlocks,
      }),
    });
    setSaveState(response.ok ? "saved" : "failed");
    setToast(response.ok ? t.saved : t.configuration);
  };
  const approveDraft = async (overrideReason?: string) => {
    if (!draftId) return;
    await saveDraft();
    const persistedBlocks = blocks.map((block) => ({
      type: block.kind,
      title: block.title,
      content: {
        body: block.body,
        page: block.page,
        pageNote: block.pageNote,
        presentation: block.presentation,
        summary: block.summary,
        chart: block.chart,
        chartUnavailable: block.chartUnavailable,
        unavailableReason: block.unavailableReason,
        mediaItems: block.mediaItems ?? [],
        mediaDisplay:
          block.mediaDisplay ?? mediaSectionConfig(block.title).display,
        kpis: block.kpis ?? [],
      },
    }));
    const response = await fetch("/api/reports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: draftId,
        title: reportMetadata.title,
        isBlank: blank,
        status: "APPROVED",
        overrideReason,
        blocks: persistedBlocks,
      }),
    });
    const result = (await response.json()) as {
      readiness?: { issues?: string[] };
    };
    if (response.status === 409 && result.readiness?.issues) {
      setApprovalIssues(result.readiness.issues);
      return;
    }
    if (response.ok) {
      setApprovalIssues(null);
      setReportStatus("APPROVED");
    }
    setToast(response.ok ? t.approved : t.configuration);
  };
  const duplicateReport = async () => {
    if (!draftId || !reportMetadata.clientId) return;
    const start = new Date(`${reportMetadata.periodStart}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() + 1);
    const end = new Date(start.getUTCFullYear(), start.getUTCMonth() + 1, 0);
    const periodStart = start.toISOString().slice(0, 10);
    const periodEnd = end.toISOString().slice(0, 10);
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        duplicateFromId: draftId,
        clientId: reportMetadata.clientId,
        title: `${reportMetadata.title} — نسخة الفترة التالية`,
        periodStart: `${periodStart}T00:00:00.000Z`,
        periodEnd: `${periodEnd}T23:59:59.999Z`,
      }),
    });
    if (!response.ok) {
      setToast(t.configuration);
      return;
    }
    const data = (await response.json()) as {
      report: {
        id: string;
        blocks: Array<{ type: string; position: number; content: unknown }>;
      };
    };
    setDraftId(data.report.id);
    setReportStatus("DRAFT");
    setSaveState("saved");
    setReportMetadata((current) => ({
      ...current,
      title: `${current.title} — نسخة الفترة التالية`,
      periodStart,
      periodEnd,
    }));
    setBlocks(blocksFromReport(data.report.blocks));
    setToast("تم إنشاء نسخة للفترة التالية.");
  };
  const addBlock = (kind: Exclude<BlockKind, "kpi">) => {
    const titles = {
      text: t.text,
      chart: t.chart,
      media: t.media,
      notes: t.notes,
    };
    const chart =
      kind === "chart"
        ? {
            type: "line" as const,
            metric: t.followers,
            values: "4, 6, 5, 8, 7, 11, 13",
            insight: t.editBody,
          }
        : undefined;
    setBlocks((current) => [
      ...current,
      { id: Date.now(), kind, title: titles[kind], body: t.editBody, chart },
    ]);
    setBlank(false);
    setToast(t.sectionAdded);
  };
  const addKpiBlock = (kpis: Kpi[], presentation: MetricPresentation) => {
    setBlocks((current) =>
      kpiTargetBlockId
        ? current.map((block) =>
            block.id === kpiTargetBlockId ? { ...block, kpis } : block,
          )
        : [
            ...current,
            {
              id: Date.now(),
              kind: "kpi",
              title: t.instagramPerformance,
              body: t.sampleData,
              kpis,
              presentation,
            },
          ],
    );
    setKpiTargetBlockId(null);
    setBlank(false);
    setKpiPickerOpen(false);
    setToast(t.sectionAdded);
  };
  const updateBlock = (id: number, field: "title" | "body", value: string) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === id ? { ...block, [field]: value } : block,
      ),
    );
  const updateSummary = (
    id: number,
    field: keyof MonthlySummary,
    value: string,
  ) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === id
          ? {
              ...block,
              summary: {
                achievements: "",
                highlights: "",
                challenges: "",
                ...block.summary,
                [field]: value,
              },
            }
          : block,
      ),
    );
  const updateKpi = (
    blockId: number,
    kpiId: string,
    field: "label" | "value" | "change" | "display",
    value: string,
  ) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === blockId
          ? {
              ...block,
              kpis: block.kpis?.map((kpi) =>
                kpi.id === kpiId ? { ...kpi, [field]: value } : kpi,
              ),
            }
          : block,
      ),
    );
  const updatePageNote = (id: number, pageNote: string | undefined) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === id ? { ...block, pageNote } : block,
      ),
    );
  const updateMediaItems = (id: number, mediaItems: MediaPost[]) =>
    setBlocks((current) =>
      current.map((block) => {
        if (block.id !== id) return block;
        const uniqueItems = [...(block.mediaItems ?? []), ...mediaItems].filter(
          (item, index, all) =>
            all.findIndex((candidate) => candidate.id === item.id) === index,
        );
        return { ...block, mediaItems: uniqueItems };
      }),
    );
  const updateMediaDisplay = (id: number, mediaDisplay: string[]) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === id ? { ...block, mediaDisplay } : block,
      ),
    );
  const removeMediaItem = (blockId: number, itemId: string) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === blockId
          ? {
              ...block,
              mediaItems: (block.mediaItems ?? []).filter(
                (item) => item.id !== itemId,
              ),
            }
          : block,
      ),
    );
  const updateChart = (id: number, field: keyof ChartConfig, value: string) =>
    setBlocks((current) =>
      current.map((block) =>
        block.id === id && block.chart
          ? {
              ...block,
              chart: {
                ...block.chart,
                [field]:
                  field === "type" ? (value as ChartConfig["type"]) : value,
              },
            }
          : block,
      ),
    );
  const removeBlock = (id: number) =>
    setBlocks((current) => current.filter((block) => block.id !== id));
  const moveBlock = (id: number, direction: number) =>
    setBlocks((current) => {
      const index = current.findIndex((block) => block.id === id);
      const next = index + direction;
      if (next < 0 || next >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
      return reordered;
    });
  const loadReport = async (reportId?: string) => {
    const response = await fetch("/api/reports");
    if (!response.ok) {
      setView("reports");
      setSelectedReportId(null);
      return;
    }
    const data = (await response.json()) as {
      reports: Array<{
        id: string;
        title: string;
        clientId: string;
        periodStart: string;
        periodEnd: string;
        isBlank: boolean;
        status: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "EXPORTED";
        dataRefreshedAt?: string | null;
        blocks: Array<{ type: string; position: number; content: unknown }>;
      }>;
    };
    const report = reportId
      ? data.reports.find((item) => item.id === reportId)
      : data.reports[0];
    if (!report) {
      setView("reports");
      setSelectedReportId(null);
      return;
    }
    const typeMap: Record<string, BlockKind> = {
      TEXT: "text",
      KPI: "kpi",
      CHART: "chart",
      PLATFORM_ANALYTICS: "chart",
      MEDIA: "media",
      NOTES: "notes",
      RECOMMENDATIONS: "notes",
    };
    setBlocks(
      report.blocks.map((block) => {
        const content = block.content as Record<string, unknown>;
        return {
          id: block.position + 1,
          kind: typeMap[block.type] ?? "text",
          title: typeof content.title === "string" ? content.title : t.text,
          body: typeof content.body === "string" ? content.body : "",
          page:
            content.page === "cover" || content.page === "closing"
              ? content.page
              : undefined,
          pageNote:
            typeof content.pageNote === "string" ? content.pageNote : undefined,
          presentation:
            content.presentation === "cards" ||
            content.presentation === "line" ||
            content.presentation === "bar"
              ? content.presentation
              : undefined,
          chart:
            content.chart &&
            typeof content.chart === "object" &&
            !Array.isArray(content.chart)
              ? (content.chart as ChartConfig)
              : undefined,
          mediaItems: Array.isArray(content.mediaItems)
            ? (content.mediaItems as MediaPost[]).filter(
                (item, index, items) =>
                  items.findIndex((candidate) => candidate.id === item.id) ===
                  index,
              )
            : undefined,
          mediaDisplay: normalizeLegacyMediaDisplay(
            typeof content.title === "string" ? content.title : t.text,
            content.mediaDisplay,
          ),
          summary:
            content.summary &&
            typeof content.summary === "object" &&
            !Array.isArray(content.summary)
              ? (content.summary as MonthlySummary)
              : undefined,
          kpis: Array.isArray(content.kpis)
            ? (content.kpis as Kpi[])
            : undefined,
        };
      }),
    );
    setBlank(report.isBlank);
    setReportMetadata({
      title: report.title,
      clientId: report.clientId,
      periodStart: report.periodStart.slice(0, 10),
      periodEnd: report.periodEnd.slice(0, 10),
      periodType: "monthly",
    });
    setSelectedClientId(report.clientId);
    setDraftId(report.id);
    setReportStatus(report.status);
    setSaveState("saved");
    setSelectedReportId(report.id);
    setLastSyncedAt(report.dataRefreshedAt ? new Date(report.dataRefreshedAt).toISOString() : null);
    setView("reports");
  };
  const loadSavedDraft = () => loadReport();
  const navItems = [
    { id: "dashboard" as const, icon: LayoutDashboard, label: t.dashboard },
    { id: "reports" as const, icon: FileText, label: t.reports },
    { id: "clients" as const, icon: Users, label: t.clients },
    { id: "accounts" as const, icon: Link2, label: t.accounts },
    { id: "settings" as const, icon: Settings, label: t.settings },
  ];
  if (user === undefined) return <div className="auth-loading" />;
  if (!user)
    return (
      <SignIn
        language={language}
        onLanguageChange={setLanguage}
        onSignedIn={setUser}
      />
    );

  return (
    <div
      className={`shell ${rtl ? "rtl" : "english"}`}
      dir={rtl ? "rtl" : "ltr"}
    >
      <aside className="sidebar">
        <div className="brand">
          <img
            src="/kaan-white-logo.png"
            alt="KAAN Achievement Reports"
            className="brand-logo"
          />
        </div>
        <div className="nav-group">
          <div className="nav-title">{t.workspace}</div>
          {navItems.slice(0, 3).map(({ id, icon: Icon, label }) => (
            <button
              className={`nav-item ${view === id ? "active" : ""}`}
              key={id}
              onClick={() => {
                setView(id);
                if (id === "reports") setSelectedReportId(null);
              }}
            >
              <Icon className="nav-icon" size={18} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-title">{t.management}</div>
          {navItems.slice(3).map(({ id, icon: Icon, label }) => (
            <button
              className={`nav-item ${view === id ? "active" : ""}`}
              key={id}
              onClick={() => setView(id)}
            >
              <Icon className="nav-icon" size={18} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-foot">
          Kaan Agency
          <br />
          {t.internalReports}
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">
            <b>
              {view === "dashboard"
                ? t.dashboard
                : view === "reports"
                  ? t.reports
                  : t[view]}
            </b>
            {view === "reports" &&
              blocks.length > 0 &&
              ` / ${reportMetadata.title}`}
          </div>
          <div className="profile">
            <button
              className="lang"
              onClick={() => setLanguage(rtl ? "EN" : "AR")}
            >
              {rtl ? "English" : "العربية"}
            </button>
          </div>
        </header>
        {toast && (
          <div className="toast">
            <CheckCircle2 size={17} />
            {toast}
          </div>
        )}
        {view === "dashboard" && (
          <Dashboard
            t={t}
            serviceReady={serviceReady}
            startTemplate={openReportSetup}
            openReports={() => {
              setSelectedReportId(null);
              setView("reports");
            }}
            openAccounts={() => setView("accounts")}
            user={user}
          />
        )}
        {view === "reports" &&
          (selectedReportId ? (
            <ReportBuilder
              t={t}
              reportTitle={reportMetadata.title}
              reportPeriod={reportMetadata.periodType}
              reportStatus={reportStatus}
              saveState={saveState}
              blocks={blocks}
              blank={blank}
              user={user}
              reportId={draftId}
              clientId={reportMetadata.clientId}
              periodStart={reportMetadata.periodStart}
              periodEnd={reportMetadata.periodEnd}
              setView={setView}
              startTemplate={openReportSetup}
              addBlock={addBlock}
              onSave={saveDraft}
              onPreview={() => setPreviewOpen(true)}
              onRefreshData={refreshReportData}
              onApprove={approveDraft}
              onDuplicate={duplicateReport}
              lastSyncedAt={lastSyncedAt}
              openKpiPicker={() => {
                setKpiTargetBlockId(null);
                setKpiPickerOpen(true);
              }}
              openKpiForBlock={(id) => {
                setKpiTargetBlockId(id);
                setKpiPickerOpen(true);
              }}
              openMediaForBlock={setMediaTargetBlockId}
              updateBlock={updateBlock}
              updatePageNote={updatePageNote}
              updateSummary={updateSummary}
              updateKpi={updateKpi}
              updateChart={updateChart}
              updateMediaDisplay={updateMediaDisplay}
              removeMediaItem={removeMediaItem}
              removeBlock={removeBlock}
              moveBlock={moveBlock}
              setToast={setToast}
            />
          ) : (
            <ReportsList
              t={t}
              clients={workspaceClients}
              onCreate={openReportSetup}
              onOpen={(id) => void loadReport(id)}
            />
          ))}
        {view === "clients" && (
          <ClientWorkspace
            t={t}
            clients={workspaceClients}
            selectedClientId={selectedClientId}
            onSelect={setSelectedClientId}
            onRefresh={refreshClients}
            onCreated={async (client) => {
              await refreshClients();
              setSelectedClientId(client.id);
            }}
            user={user ?? null}
          />
        )}
        {view === "accounts" && (
          <ConnectedAccounts
            t={t}
            clients={workspaceClients}
            onRefresh={refreshClients}
            user={user}
          />
        )}
        {view === "settings" && (
          <SettingsPage
            t={t}
            user={user}
            onSignOut={async () => {
              await fetch("/api/auth/logout", { method: "POST" });
              setUser(null);
            }}
            setToast={setToast}
          />
        )}
      </main>
      {generatingReport && (
        <div className="generating-backdrop" role="status" aria-live="polite">
          <section className="generating-dialog">
            <RefreshCw size={30} />
            <h2>جارٍ إنشاء التقرير</h2>
            <p>نزامن بيانات Meta ونرتب مؤشرات الفترة وأفضل المنشورات.</p>
          </section>
        </div>
      )}
      {kpiPickerOpen && (
        <KpiPicker
          t={t}
          periodType={reportMetadata.periodType}
          existingKpis={
            kpiTargetBlockId !== null
              ? blocks.find((block) => block.id === kpiTargetBlockId)?.kpis
              : undefined
          }
          onClose={() => setKpiPickerOpen(false)}
          onAdd={addKpiBlock}
        />
      )}
      {mediaTargetBlockId !== null && reportMetadata.clientId && (
        <MediaLibrary
          clientId={reportMetadata.clientId}
          periodStart={reportMetadata.periodStart}
          periodEnd={reportMetadata.periodEnd}
          defaultSort={
            mediaSectionConfig(
              blocks.find((block) => block.id === mediaTargetBlockId)?.title ??
                "",
            ).sort
          }
          existingItems={
            blocks.find((block) => block.id === mediaTargetBlockId)
              ?.mediaItems ?? []
          }
          onClose={() => setMediaTargetBlockId(null)}
          onSelect={(items) => {
            updateMediaItems(mediaTargetBlockId, items);
            setMediaTargetBlockId(null);
          }}
        />
      )}
      {approvalIssues && (
        <ApprovalOverrideDialog
          issues={approvalIssues}
          onCancel={() => setApprovalIssues(null)}
          onConfirm={(reason) => void approveDraft(reason)}
        />
      )}
      {previewOpen && (
        <ReportPreview
          t={t}
          reportId={draftId}
          reportTitle={reportMetadata.title}
          clientId={reportMetadata.clientId}
          periodStart={reportMetadata.periodStart}
          periodEnd={reportMetadata.periodEnd}
          clientLogo={
            workspaceClients.find(
              (client) => client.id === reportMetadata.clientId,
            )?.logoUrl
          }
          blocks={blocks}
          onClose={() => setPreviewOpen(false)}
        />
      )}
      {reportSetupOpen && (
        <ReportSetup
          t={t}
          clients={workspaceClients}
          template={setupTemplate}
          metadata={{
            ...reportMetadata,
            clientId: reportMetadata.clientId ?? selectedClientId,
          }}
          onClose={() => setReportSetupOpen(false)}
          onCreate={async (metadata) => {
            setReportSetupOpen(false);
            await startTemplate(setupTemplate, metadata);
          }}
        />
      )}
    </div>
  );
}

function Dashboard({
  t,
  serviceReady,
  startTemplate,
  openReports,
  openAccounts,
  user,
}: {
  t: Dictionary;
  serviceReady: boolean | null;
  startTemplate: (type: "standard" | "blank") => void | Promise<void>;
  openReports: () => void;
  openAccounts: () => void;
  user: WorkspaceUser | null;
}) {
  const [data, setData] = useState<{
    stats: {
      activeClients: number;
      needsReview: number;
      completedThisMonth: number;
      instagramAccounts: number;
    };
    accounts: Array<{
      id: string;
      platform: string;
      displayName: string;
      clientName: string;
      lastSuccessfulSyncAt: string | null;
    }>;
    recent: Array<{
      id: string;
      title: string;
      clientName: string;
      status: string;
      updatedAt: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch("/api/dashboard")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload) setData(payload as typeof data);
      })
      .finally(() => setLoading(false));
  }, []);

  const statusLabel = (status: string) => {
    if (status === "NEEDS_REVIEW") return t.needsReview;
    if (status === "DRAFT")
      return t.dashboard === "الرئيسية" ? "مسودة" : "Draft";
    return t.complete;
  };

  const formatValue = (value: number) => value.toLocaleString();

  const accounts = data?.accounts ?? [];
  const recent = data?.recent ?? [];
  const stats = data?.stats ?? {
    activeClients: 0,
    needsReview: 0,
    completedThisMonth: 0,
    instagramAccounts: 0,
  };

  const rtl = t.dashboard === "الرئيسية";
  const greeting = t.greeting.replace(
    "{name}",
    user?.name ?? (rtl ? "روان" : "Rawan"),
  );
  const groupedAccounts = accounts.reduce<
    Array<{ clientName: string; items: typeof accounts }>
  >((groups, account) => {
    const group = groups.find((item) => item.clientName === account.clientName);
    if (group) group.items.push(account);
    else groups.push({ clientName: account.clientName, items: [account] });
    return groups;
  }, []);
  return (
    <>
      <section className="hero">
        <div>
          <h1>{greeting}</h1>
          <p>
            {t.overview}
            {serviceReady === false && ` ${t.configuration}`}
          </p>
        </div>
        <div className="actions">
          <button className="btn quiet" onClick={() => startTemplate("blank")}>
            <Plus size={16} />
            {t.blank}
          </button>
          <button
            className="btn primary"
            onClick={() => startTemplate("standard")}
          >
            <FileText size={16} />
            {t.create}
          </button>
        </div>
      </section>
      <section className="metric-grid">
        <Metric
          label={t.activeClients}
          value={loading ? "..." : formatValue(stats.activeClients)}
          change={t.thisMonth}
          Icon={Users}
        />
        <Metric
          label={t.reviewReports}
          value={loading ? "..." : formatValue(stats.needsReview)}
          change={t.reviewNeeded}
          Icon={AlertCircle}
          warn
        />
        <Metric
          label={t.instagramAccounts}
          value={loading ? "..." : formatValue(stats.instagramAccounts)}
          change={t.lastSync}
          Icon={Instagram}
        />
        <Metric
          label={t.completedReports}
          value={loading ? "..." : formatValue(stats.completedThisMonth)}
          change={t.compared}
          Icon={CheckCircle2}
        />
      </section>
      <section className="card">
        <div className="card-title">
          <div>
            <h2>{t.connected}</h2>
            <p>{t.isolated}</p>
          </div>
          <button className="btn quiet" onClick={openAccounts}>
            {t.manage}
          </button>
        </div>
        {groupedAccounts.map((group) => (
          <ClientConnectionsRow
            key={group.clientName}
            clientName={group.clientName}
            items={group.items}
            label={t.connectedStatus}
            disconnectedLabel={t.disconnected}
            onClick={openAccounts}
          />
        ))}
        {accounts.length === 0 && (
          <p>{loading ? "جارٍ تحميل الحسابات..." : "لا توجد حسابات متصلة."}</p>
        )}
        <button className="btn quiet full-width" onClick={openAccounts}>
          <Plus size={16} />
          {t.connectAccount}
        </button>
      </section>
      <section className="card report-list">
        <div className="card-title">
          <div>
            <h2>{t.recent}</h2>
            <p>{t.recentDesc}</p>
          </div>
          <button className="btn quiet" onClick={openReports}>
            {t.showAll}
          </button>
        </div>
        {recent.map((report) => (
          <Report
            key={report.id}
            title={report.title}
            subtitle={`${report.clientName} · ${report.updatedAt ? new Date(report.updatedAt).toLocaleDateString() : ""}`}
            status={statusLabel(report.status)}
            onOpen={openReports}
            open={t.open}
          />
        ))}
        {recent.length === 0 && (
          <p>{loading ? "جارٍ تحميل التقارير..." : "لا توجد تقارير حديثة."}</p>
        )}
      </section>
    </>
  );
}

type ReportListItem = {
  id: string;
  title: string;
  clientId: string;
  clientName: string;
  status: string;
  updatedAt: string;
};

function ReportsList({
  t,
  clients,
  onCreate,
  onOpen,
}: {
  t: Dictionary;
  clients: WorkspaceClient[];
  onCreate: (type: "standard" | "blank") => void;
  onOpen: (id: string) => void;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [clientFilter, setClientFilter] = useState("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ReportListItem | null>(
    null,
  );
  const statusLabel = (status: string) => {
    if (status === "NEEDS_REVIEW") return t.needsReview;
    if (status === "DRAFT") return arabic ? "مسودة" : "Draft";
    return t.complete;
  };
  const loadReports = () => {
    setLoading(true);
    return fetch("/api/reports")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const items = (data?.reports ?? []).map(
          (report: {
            id: string;
            title: string;
            clientId: string;
            client: { name: string };
            status: string;
            updatedAt: string;
          }) => ({
            id: report.id,
            title: report.title,
            clientId: report.clientId,
            clientName: report.client?.name ?? "",
            status: report.status,
            updatedAt: report.updatedAt,
          }),
        );
        setReports(items);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void loadReports();
  }, []);
  const deleteReport = async (report: ReportListItem) => {
    setConfirmDelete(null);
    setDeleting(report.id);
    setError("");
    const response = await fetch(`/api/reports?id=${report.id}&confirm=true`, {
      method: "DELETE",
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok)
      setError(
        data.error ??
          (arabic ? "تعذر حذف التقرير." : "Unable to delete the report."),
      );
    else await loadReports();
    setDeleting(null);
  };
  const filtered = reports
    .filter(
      (report) =>
        filter === "all" ||
        (filter === "review"
          ? report.status === "NEEDS_REVIEW"
          : report.status === "APPROVED" || report.status === "EXPORTED"),
    )
    .filter(
      (report) => clientFilter === "all" || report.clientId === clientFilter,
    );
  return (
    <section className="report-list-page">
      <section className="hero">
        <div>
          <h1>{t.reports}</h1>
          <p>
            {arabic
              ? "جميع التقارير مرتبة حسب آخر تحديث."
              : "All reports sorted by last update."}
          </p>
        </div>
        <div className="actions">
          <button className="btn quiet" onClick={() => onCreate("blank")}>
            <Plus size={16} />
            {t.blank}
          </button>
          <button className="btn primary" onClick={() => onCreate("standard")}>
            <FileText size={16} />
            {t.create}
          </button>
        </div>
      </section>
      {error && <div className="notice">{error}</div>}
      <div className="report-filters">
        <select
          value={clientFilter}
          onChange={(event) => setClientFilter(event.target.value)}
        >
          <option value="all">{arabic ? "جميع العملاء" : "All clients"}</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <select
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">{arabic ? "الكل" : "All"}</option>
          <option value="review">{t.needsReview}</option>
          <option value="complete">{t.complete}</option>
        </select>
      </div>
      <section className="card report-list">
        <div className="report-list-head">
          <span>{arabic ? "التقرير" : "Report"}</span>
          <span>{arabic ? "الحالة" : "Status"}</span>
          <span>{arabic ? "آخر تحديث" : "Updated"}</span>
          <span></span>
        </div>
        {loading ? (
          <p>{arabic ? "جارٍ تحميل التقارير..." : "Loading reports..."}</p>
        ) : (
          filtered.map((report) => (
            <div className="report-row" key={report.id}>
              <div>
                <b>{report.title}</b>
                <small>{report.clientName}</small>
              </div>
              <span className="status">{statusLabel(report.status)}</span>
              <span>{new Date(report.updatedAt).toLocaleDateString()}</span>
              <div className="report-row-actions">
                <button
                  className="btn quiet compact"
                  onClick={() => onOpen(report.id)}
                >
                  {t.open}
                </button>
                {report.status !== "APPROVED" &&
                  report.status !== "EXPORTED" && (
                    <button
                      className="btn quiet compact danger-button"
                      disabled={deleting === report.id}
                      aria-label={arabic ? "حذف التقرير" : "Delete report"}
                      onClick={() => setConfirmDelete(report)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
              </div>
            </div>
          ))
        )}
        {!loading && filtered.length === 0 && (
          <p>{arabic ? "لا توجد تقارير مطابقة." : "No matching reports."}</p>
        )}
      </section>
      {confirmDelete && (
        <ConfirmDialog
          title={arabic ? "حذف التقرير نهائياً؟" : "Delete report permanently?"}
          message={
            arabic
              ? `حذف "${confirmDelete.title}" نهائياً؟ لا يمكن استعادته.`
              : `Delete "${confirmDelete.title}" permanently? This cannot be undone.`
          }
          confirmLabel={arabic ? "حذف نهائياً" : "Delete permanently"}
          cancelLabel={t.cancel}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void deleteReport(confirmDelete)}
        />
      )}
    </section>
  );
}

function ReportBuilder({
  t,
  reportTitle,
  reportPeriod,
  reportStatus,
  saveState,
  blocks,
  blank,
  user,
  reportId,
  clientId,
  periodStart,
  periodEnd,
  setView,
  startTemplate,
  addBlock,
  onSave,
  onPreview,
  onRefreshData,
  onApprove,
  onDuplicate,
  lastSyncedAt,
  openKpiPicker,
  openKpiForBlock,
  openMediaForBlock,
  updateBlock,
  updatePageNote,
  updateSummary,
  updateKpi,
  updateChart,
  updateMediaDisplay,
  removeMediaItem,
  removeBlock,
  moveBlock,
  setToast,
}: {
  t: Dictionary;
  reportTitle: string;
  reportPeriod: ReportPeriod;
  reportStatus: "DRAFT" | "NEEDS_REVIEW" | "APPROVED" | "EXPORTED";
  saveState: "idle" | "saving" | "saved" | "failed";
  blocks: Block[];
  blank: boolean;
  user: WorkspaceUser | null;
  reportId: string | null;
  clientId: string | null;
  periodStart: string;
  periodEnd: string;
  setView: (view: View) => void;
  startTemplate: (type: "standard" | "blank") => void | Promise<void>;
  addBlock: (kind: Exclude<BlockKind, "kpi">) => void;
  onSave: () => Promise<void>;
  onPreview: () => void;
  onRefreshData: () => Promise<string>;
  onApprove: () => Promise<void>;
  onDuplicate: () => Promise<void>;
  lastSyncedAt: string | null;
  openKpiPicker: () => void;
  openKpiForBlock: (id: number) => void;
  openMediaForBlock: (id: number) => void;
  updateBlock: (id: number, field: "title" | "body", value: string) => void;
  updatePageNote: (id: number, value: string | undefined) => void;
  updateSummary: (
    id: number,
    field: keyof MonthlySummary,
    value: string,
  ) => void;
  updateKpi: (
    blockId: number,
    kpiId: string,
    field: "label" | "value" | "change" | "display",
    value: string,
  ) => void;
  updateChart: (id: number, field: keyof ChartConfig, value: string) => void;
  updateMediaDisplay: (id: number, display: string[]) => void;
  removeMediaItem: (blockId: number, itemId: string) => void;
  removeBlock: (id: number) => void;
  moveBlock: (id: number, direction: number) => void;
  setToast: (value: string) => void;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const [refreshing, setRefreshing] = useState(false);
  const groups: Array<{
    label: string;
    items: Array<{ kind: BlockKind; label: string }>;
  }> = arabic
    ? [
        {
          label: "الإحصائيات والرسوم",
          items: [{ kind: "kpi", label: "بطاقات مؤشرات الأداء ورسومها" }],
        },
        {
          label: "المنشورات والمحتوى",
          items: [{ kind: "media", label: "منشورات وصور" }],
        },
        {
          label: "ملاحظات وتوصيات",
          items: [{ kind: "notes", label: "صفحة ملاحظات وتوصيات مستقلة" }],
        },
        {
          label: "الغلاف والختام",
          items: [{ kind: "text", label: "قسم نصي للغلاف أو الختام" }],
        },
      ]
    : [
        {
          label: "Statistics & charts",
          items: [{ kind: "kpi", label: "KPI cards and charts" }],
        },
        {
          label: "Posts & content",
          items: [{ kind: "media", label: "Posts and images" }],
        },
        {
          label: "Narrative & recommendations",
          items: [{ kind: "notes", label: "Notes and recommendations" }],
        },
        {
          label: "Cover & closing",
          items: [{ kind: "text", label: "Cover or closing text" }],
        },
      ];
  const refresh = async () => {
    setRefreshing(true);
    try {
      const syncedAt = await onRefreshData();
      setToast(
        syncedAt === "queued"
          ? "تم وضع مزامنة Meta في قائمة الانتظار. حدّثي التقرير بعد اكتمالها."
          : `تم تحديث البيانات · ${new Date(syncedAt).toLocaleString()}`,
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "فشل تحديث البيانات.");
    }
    setRefreshing(false);
  };
  const syncLabel = lastSyncedAt
    ? `آخر تحديث: ${new Date(lastSyncedAt).toLocaleString()}`
    : null;
  const [exporting, setExporting] = useState(false);
  const [coverage, setCoverage] = useState<CoverageState | null>(null);
  useEffect(() => {
    if (!clientId) {
      setCoverage(null);
      return;
    }
    fetch(
      `/api/clients/${clientId}/coverage?periodStart=${periodStart}&periodEnd=${periodEnd}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { coverage?: CoverageState } | null) =>
        setCoverage(data?.coverage ?? null),
      )
      .catch(() => setCoverage(null));
  }, [clientId, periodStart, periodEnd]);
  // TODO: re-enable once Google Slides export is fully verified.
  const canExportSlides =
    false &&
    user?.role !== "VIEWER" &&
    (reportStatus === "APPROVED" || reportStatus === "EXPORTED");
  const exportSlides = async () => {
    if (!reportId) return;
    if (!user?.googleConnected) {
      window.location.href = "/api/connectors/google";
      return;
    }
    setExporting(true);
    try {
      const response = await fetch(`/api/reports/${reportId}/slides`, {
        method: "POST",
      });
      const data = (await response.json()) as {
        export?: { fileUrl?: string };
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? "Export failed.");
      setToast(
        data.export?.fileUrl
          ? `Exported to Google Slides: ${data.export.fileUrl}`
          : "Exported to Google Slides.",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Unable to export.");
    }
    setExporting(false);
  };
  const coverageIssues =
    coverage && coverage.status !== "COMPLETE"
      ? coverage.warnings.slice(0, 3)
      : [];
  const readinessIssues = [
    ...(!lastSyncedAt ? ["لم يتم تحديث بيانات التقرير أثناء هذه الجلسة"] : []),
    ...coverageIssues,
    ...blocks
      .filter(
        (block) =>
          block.kind === "media" && (block.mediaItems?.length ?? 0) === 0,
      )
      .map((block) => `قسم «${block.title}» بلا منشورات`),
    ...blocks
      .filter((block) => block.chartUnavailable)
      .map((block) => `بيانات «${block.title}» غير متاحة`),
  ];
  return (
    <>
      <section className="hero">
        <div>
          <h1>{reportTitle}</h1>
          <p>
            {reportStatus === "APPROVED"
              ? "معتمد ومحفوظ كنسخة نهائية"
              : saveState === "saving"
                ? "جارٍ الحفظ..."
                : saveState === "saved"
                  ? "تم الحفظ"
                  : saveState === "failed"
                    ? "تعذر الحفظ"
                    : "مسودة"}
          </p>
        </div>
        <div className="actions">
          <button
            className="btn quiet"
            disabled={reportStatus === "APPROVED" || saveState === "saving"}
            onClick={async () => {
              await onSave();
              setView("dashboard");
            }}
          >
            <Save size={16} />
            {saveState === "saving" ? "جارٍ الحفظ..." : t.saveExit}
          </button>
          <button className="btn accent" onClick={onPreview}>
            <Eye size={16} />
            {t.previewExport}
          </button>
          <button
            className="btn primary"
            disabled={reportStatus === "APPROVED"}
            onClick={() => void onApprove()}
          >
            <CheckCircle2 size={16} />
            {reportStatus === "APPROVED" ? "تم الاعتماد" : t.approve}
          </button>
          {canExportSlides && (
            <button
              className="btn accent"
              disabled={exporting}
              onClick={() => void exportSlides()}
            >
              <FileText size={16} />
              {user?.googleConnected
                ? exporting
                  ? "جارٍ التصدير..."
                  : "Export to Slides"
                : "Connect Google"}
            </button>
          )}
          <button className="btn quiet" onClick={() => void onDuplicate()}>
            <FileText size={16} />
            نسخ للفترة التالية
          </button>
        </div>
      </section>
      {reportStatus !== "APPROVED" && readinessIssues.length > 0 && (
        <div className="report-readiness">
          <b>قبل الاعتماد</b>
          <ul>
            {readinessIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="notice">
        <span>
          <strong>{t.assistant}</strong> {t.assistantText}
          {syncLabel && <small> · {syncLabel}</small>}
        </span>
        <button
          className="btn quiet"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
          {refreshing ? "جارٍ التحديث..." : t.refresh}
        </button>
      </div>
      <section
        className={`builder ${reportStatus === "APPROVED" ? "report-frozen" : ""}`}
      >
        <aside className="card toolbox">
          <h3>{t.addReport}</h3>
          <p>{t.addReportDesc}</p>
          <div className="toolbox-groups">
            {groups.map((group) => (
              <section className="toolbox-group" key={group.label}>
                <h4>{group.label}</h4>
                {group.items.map(({ kind, label }) => {
                  const Icon = blockIcons[kind];
                  return (
                    <button
                      className="block-btn"
                      key={kind}
                      onClick={() =>
                        kind === "kpi" ? openKpiPicker() : addBlock(kind)
                      }
                    >
                      <Plus size={15} />
                      <Icon size={15} />
                      {label}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
          <hr />
          <button
            className="btn quiet full-width"
            onClick={() => startTemplate("standard")}
          >
            <RefreshCw size={15} />
            {t.restore}
          </button>
        </aside>
        <div className="block-list">
          {blank && blocks.length === 0 ? (
            <div className="empty-template">
              <div>
                <FileText size={34} />
                <strong>{t.blankTitle}</strong>
                <span>{t.blankText}</span>
              </div>
            </div>
          ) : (
            blocks.map((block, index) => (
              <ReportBlock
                key={block.id}
                block={block}
                reportPeriod={reportPeriod}
                index={index}
                count={blocks.length}
                t={t}
                onUpdate={updateBlock}
                onUpdateSummary={updateSummary}
                onUpdateKpi={updateKpi}
                onAddMetrics={openKpiForBlock}
                onOpenMedia={openMediaForBlock}
                onUpdatePageNote={updatePageNote}
                onUpdateChart={updateChart}
                onUpdateMediaDisplay={updateMediaDisplay}
                onRemoveMediaItem={removeMediaItem}
                onRemove={removeBlock}
                onMove={moveBlock}
              />
            ))
          )}
        </div>
      </section>
    </>
  );
}

function ReportBlock({
  block,
  reportPeriod,
  index,
  count,
  t,
  onUpdate,
  onUpdateSummary,
  onUpdateKpi,
  onAddMetrics,
  onOpenMedia,
  onUpdatePageNote,
  onUpdateChart,
  onUpdateMediaDisplay,
  onRemoveMediaItem,
  onRemove,
  onMove,
}: {
  block: Block;
  reportPeriod: ReportPeriod;
  index: number;
  count: number;
  t: Dictionary;
  onUpdate: (id: number, field: "title" | "body", value: string) => void;
  onUpdateSummary: (
    id: number,
    field: keyof MonthlySummary,
    value: string,
  ) => void;
  onUpdateKpi: (
    blockId: number,
    kpiId: string,
    field: "label" | "value" | "change" | "display",
    value: string,
  ) => void;
  onAddMetrics: (id: number) => void;
  onOpenMedia: (id: number) => void;
  onUpdatePageNote: (id: number, value: string | undefined) => void;
  onUpdateChart: (id: number, field: keyof ChartConfig, value: string) => void;
  onUpdateMediaDisplay: (id: number, display: string[]) => void;
  onRemoveMediaItem: (blockId: number, itemId: string) => void;
  onRemove: (id: number) => void;
  onMove: (id: number, direction: number) => void;
}) {
  const Icon = blockIcons[block.kind];
  return (
    <article className="editable-block">
      <div className="block-head">
        <div className="block-heading">
          <Icon size={18} />
          <h3
            contentEditable
            suppressContentEditableWarning
            onBlur={(event) =>
              onUpdate(block.id, "title", event.currentTarget.textContent ?? "")
            }
          >
            {block.title}
          </h3>
        </div>
        <div className="block-actions">
          <button
            className="mini"
            disabled={index === 0}
            aria-label="Move up"
            onClick={() => onMove(block.id, -1)}
          >
            <ArrowUp size={15} />
          </button>
          <button
            className="mini"
            disabled={index === count - 1}
            aria-label="Move down"
            onClick={() => onMove(block.id, 1)}
          >
            <ArrowDown size={15} />
          </button>
          <button
            className="mini danger"
            aria-label="Remove section"
            onClick={() => onRemove(block.id)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {block.kind === "kpi" && block.kpis ? (
        <>
          <button
            className="btn quiet compact add-metric-to-block"
            onClick={() => onAddMetrics(block.id)}
          >
            <Plus size={14} />
            إضافة مؤشر إلى هذه الصفحة
          </button>
          <div className="kpi-card-grid">
            {block.kpis!.map((kpi, kpiIndex) =>
              kpi.display === "line" || kpi.display === "bar" ? (
                <MetricTrendChart
                  key={kpi.id}
                  kpi={kpi}
                  periodType={reportPeriod}
                  onDisplayChange={(value) =>
                    onUpdateKpi(block.id, kpi.id, "display", value)
                  }
                />
              ) : (
                <div className="report-kpi-card" key={kpi.id}>
                  <select
                    value={kpi.display ?? "cards"}
                    onChange={(event) =>
                      onUpdateKpi(
                        block.id,
                        kpi.id,
                        "display",
                        event.target.value,
                      )
                    }
                  >
                    <option value="cards">بطاقة رقم</option>
                    <option value="line">رسم خطي</option>
                    <option value="bar">رسم أعمدة</option>
                  </select>
                  <span
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(event) =>
                      onUpdateKpi(
                        block.id,
                        kpi.id,
                        "label",
                        event.currentTarget.textContent ?? "",
                      )
                    }
                  >
                    {kpi.label}
                  </span>
                  <strong
                    contentEditable
                    suppressContentEditableWarning
                    onBlur={(event) =>
                      onUpdateKpi(
                        block.id,
                        kpi.id,
                        "value",
                        event.currentTarget.textContent ?? "",
                      )
                    }
                  >
                    {kpi.value}
                  </strong>
                  {kpi.change && (
                    <small
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={(event) =>
                        onUpdateKpi(
                          block.id,
                          kpi.id,
                          "change",
                          event.currentTarget.textContent ?? "",
                        )
                      }
                    >
                      {kpi.change}
                    </small>
                  )}
                </div>
              ),
            )}
          </div>
        </>
      ) : block.kind === "media" ? (
        <MediaBlock
          items={block.mediaItems ?? []}
          title={block.title}
          display={
            block.mediaDisplay ?? mediaSectionConfig(block.title).display
          }
          onOpen={() => onOpenMedia(block.id)}
          onRemove={(itemId) => onRemoveMediaItem(block.id, itemId)}
          onDisplayChange={(display) => onUpdateMediaDisplay(block.id, display)}
        />
      ) : block.chartUnavailable ? (
        <div className="chart-unavailable">
          <AlertCircle size={22} />
          <b>بيانات الرسم غير متاحة</b>
          <span>{block.unavailableReason ?? block.body}</span>
        </div>
      ) : block.chart ? (
        <ChartEditor
          chart={block.chart}
          onChange={(field, value) => onUpdateChart(block.id, field, value)}
        />
      ) : block.summary ? (
        <MonthlySummaryEditor
          summary={block.summary}
          t={t}
          onChange={(field, value) => onUpdateSummary(block.id, field, value)}
        />
      ) : (
        <p
          contentEditable
          suppressContentEditableWarning
          onBlur={(event) =>
            onUpdate(block.id, "body", event.currentTarget.textContent ?? "")
          }
        >
          {block.body}
        </p>
      )}
      {block.page !== "cover" && (
        <PageNote
          value={block.pageNote}
          onChange={(value) => onUpdatePageNote(block.id, value)}
        />
      )}
      <small>{t.editHint}</small>
    </article>
  );
}

function PageNote({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const [open, setOpen] = useState(Boolean(value));
  if (!open)
    return (
      <button
        className="btn quiet compact page-note-add"
        onClick={() => setOpen(true)}
      >
        <StickyNote size={14} />
        إضافة ملاحظة وتوصية
      </button>
    );
  return (
    <div className="page-note">
      <div>
        <b>ملاحظات وتوصيات هذه الصفحة</b>
        <button
          className="mini"
          onClick={() => {
            onChange(undefined);
            setOpen(false);
          }}
        >
          <X size={14} />
        </button>
      </div>
      <textarea
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
        placeholder="أضيفي ملاحظة تحليلية أو توصية مرتبطة بهذا القسم."
        rows={3}
      />
    </div>
  );
}

const metricLabels: Record<string, string> = {
  total_interactions: "تفاعل",
  views: "مشاهدة",
  follows: "متابع جديد",
  likes: "إعجاب",
  comments: "تعليق",
  shares: "مشاركة",
  saved: "حفظ",
  reach: "وصول",
};
function MediaMetrics({
  metrics,
  display = ["total_interactions", "views"],
}: {
  metrics: Record<string, number>;
  display?: string[];
}) {
  const keys =
    display.includes("total_interactions") && display.includes("views")
      ? ["total_interactions", "views"]
      : display;
  return (
    <div className="media-metrics">
      {keys.map((key) => {
        const value = metrics[key] ?? 0;
        return (
          <span key={key}>
            <b>{value.toLocaleString()}</b>
            <small>{metricLabels[key] ?? key}</small>
          </span>
        );
      })}
    </div>
  );
}

const availableMetricOptions = [
  { key: "total_interactions", label: "تفاعل" },
  { key: "views", label: "مشاهدة" },
  { key: "follows", label: "متابع جديد" },
  { key: "likes", label: "إعجاب" },
  { key: "comments", label: "تعليق" },
  { key: "shares", label: "مشاركة" },
  { key: "saved", label: "حفظ" },
  { key: "reach", label: "وصول" },
];
function MediaBlock({
  items,
  title,
  display = ["total_interactions", "views"],
  onOpen,
  onRemove,
  onDisplayChange,
}: {
  items: MediaPost[];
  title: string;
  display?: string[];
  onOpen: () => void;
  onRemove?: (itemId: string) => void;
  onDisplayChange?: (display: string[]) => void;
}) {
  const isFollowerSection = title.includes("اكتساب المتابعين");
  return (
    <div className="media-block">
      <div className="media-block-head">
        <button className="btn quiet compact" onClick={onOpen}>
          <ImageIcon size={15} />
          اختيار منشورات من المكتبة
        </button>
        {onDisplayChange && (
          <label className="media-display-filter">
            المؤشرات
            <select
              multiple={false}
              value={display.join(",")}
              onChange={(event) =>
                onDisplayChange(event.target.value.split(",").filter(Boolean))
              }
            >
              <option value="total_interactions,views">تفاعل + مشاهدة</option>
              <option value="views">مشاهدة</option>
              <option value="total_interactions">تفاعل</option>
              <option value="follows">متابع جديد</option>
              <option value="likes">إعجاب</option>
              <option value="comments">تعليق</option>
              <option value="shares">مشاركة</option>
              <option value="saved">حفظ</option>
              <option value="reach">وصول</option>
            </select>
          </label>
        )}
      </div>
      {items.length === 0 ? (
        <p>اختاري منشورات العميل لعرضها مع أرقام الأداء والملاحظات.</p>
      ) : (
        <div className="media-grid">
          {items.map((item) => (
            <article key={item.id}>
              {(item.thumbnailUrl ?? item.mediaUrl) && (
                <img src={item.thumbnailUrl ?? item.mediaUrl ?? ""} alt="" />
              )}
              {item.isCollaborative && <span className="media-collab-badge">مشترك</span>}
              {onRemove && (
                <button
                  className="mini media-remove"
                  onClick={() => onRemove(item.id)}
                  title="إزالة"
                >
                  <X size={12} />
                </button>
              )}
              <MediaMetrics metrics={item.metrics} display={display} />
              {isFollowerSection && !(item.metrics.follows ?? 0) && (
                <small className="follower-unavailable">
                  بيانات اكتساب المتابعين غير متاحة لهذا المنشور. يرجى إدخالها
                  يدويًا.
                </small>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function MediaLibrary({
  clientId,
  periodStart,
  periodEnd,
  defaultSort,
  existingItems = [],
  onClose,
  onSelect,
}: {
  clientId: string;
  periodStart: string;
  periodEnd: string;
  defaultSort?: "score" | "interactions" | "views" | "follows" | "newest";
  existingItems?: MediaPost[];
  onClose: () => void;
  onSelect: (items: MediaPost[]) => void;
}) {
  const existingIds = new Set(existingItems.map((item) => item.id));
  const existingManual = existingItems.filter((item) =>
    item.id.startsWith("manual-"),
  );
  const [posts, setPosts] = useState<MediaPost[]>([]);
  const [selected, setSelected] = useState<string[]>(
    existingItems
      .filter((item) => !item.id.startsWith("manual-"))
      .map((item) => item.id),
  );
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [sortBy, setSortBy] = useState<
    "score" | "interactions" | "views" | "follows" | "newest"
  >(defaultSort ?? "score");
  const [mode, setMode] = useState<"synced" | "manual">("synced");
  const [manualPosts, setManualPosts] = useState<MediaPost[]>(existingManual);
  const [selectedManual, setSelectedManual] = useState<string[]>(
    existingManual.map((item) => item.id),
  );
  const [manualCaption, setManualCaption] = useState("");
  const [manualMediaUrl, setManualMediaUrl] = useState("");
  const [manualInteractions, setManualInteractions] = useState("");
  const [manualViews, setManualViews] = useState("");
  const [manualFollows, setManualFollows] = useState("");
  const [manualExtraMetrics, setManualExtraMetrics] = useState<
    Record<string, string>
  >({ likes: "", comments: "", shares: "", saved: "", reach: "" });
  const [editingManualId, setEditingManualId] = useState<string | null>(null);
  const [instagramUrl, setInstagramUrl] = useState("");
  const [resolvingUrl, setResolvingUrl] = useState(false);
  const [urlError, setUrlError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const periodStartDate = new Date(periodStart);
  const periodEndDate = new Date(`${periodEnd}T23:59:59.999Z`);
  const [coverage, setCoverage] = useState<CoverageState | null>(null);
  const load = async () => {
    setLoading(true);
    const [postsResponse, coverageResponse] = await Promise.all([
      fetch(`/api/clients/${clientId}/posts`),
      fetch(
        `/api/clients/${clientId}/coverage?periodStart=${periodStart}&periodEnd=${periodEnd}`,
      ),
    ]);
    const postsData = (await postsResponse.json()) as { posts?: MediaPost[] };
    const coverageData = (await coverageResponse.json()) as {
      coverage?: CoverageState;
    };
    setPosts(postsData.posts ?? []);
    setCoverage(coverageData.coverage ?? null);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, [clientId, periodStart, periodEnd]);
  const sync = async () => {
    setSyncing(true);
    await fetch(`/api/clients/${clientId}/sync`, { method: "POST" });
    await load();
    setSyncing(false);
  };
  const coverageReady =
    coverage &&
    (coverage.status === "COMPLETE" ||
      coverage.status === "PARTIAL" ||
      coverage.status === "SYNCING");
  const filterLabels: Record<typeof sortBy, string> = {
    score: "أعلى أداء عام",
    interactions: "أعلى تفاعل",
    views: "أعلى مشاهدة",
    follows: "أعلى اكتساب متابعين",
    newest: "الأحدث أولاً",
  };
  const metricFor = (post: MediaPost, key: typeof sortBy) =>
    key === "views"
      ? (post.metrics.views ?? 0)
      : key === "interactions"
        ? (post.metrics.total_interactions ?? 0)
        : key === "follows"
          ? (post.metrics.follows ?? 0)
          : post.score;
  const filteredPosts = posts.filter((post) => {
    const publishedAt = new Date(post.publishedAt);
    return publishedAt >= periodStartDate && publishedAt <= periodEndDate;
  });
  const displayedPosts = [...filteredPosts].sort((left, right) =>
    sortBy === "newest"
      ? new Date(right.publishedAt).valueOf() -
        new Date(left.publishedAt).valueOf()
      : metricFor(right, sortBy) - metricFor(left, sortBy),
  );
  const resolveUrl = async () => {
    if (!instagramUrl.trim()) return;
    setResolvingUrl(true);
    setUrlError("");
    const response = await fetch(`/api/clients/${clientId}/resolve-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: instagramUrl.trim() }),
    });
    const data = (await response.json()) as {
      post?: MediaPost;
      error?: string;
    };
    setResolvingUrl(false);
    if (!response.ok || !data.post) {
      setUrlError(
        data.error ??
          "تعذر جلب المنشور. يمكنك رفع الصورة أو إدخال الرابط يدوياً.",
      );
      return;
    }
    if (existingIds.has(data.post.id)) {
      setUrlError("المنشور موجود بالفعل في هذه الصفحة.");
      return;
    }
    setManualPosts((current) =>
      current.some((post) => post.id === data.post!.id)
        ? current
        : [...current, data.post!],
    );
    setSelectedManual((current) =>
      current.includes(data.post!.id) ? current : [...current, data.post!.id],
    );
    setInstagramUrl("");
  };
  const uploadFile = (file: File | null) => {
    setUploadError("");
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setUploadError("يُرجى اختيار ملف صورة.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("حجم الصورة يجب أن يكون أقل من 5 ميجابايت.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setManualMediaUrl(reader.result as string);
    };
    reader.onerror = () => setUploadError("تعذر قراءة الصورة.");
    reader.readAsDataURL(file);
  };
  const resetManualForm = () => {
    setManualCaption("");
    setManualMediaUrl("");
    setManualInteractions("");
    setManualViews("");
    setManualFollows("");
    setManualExtraMetrics({
      likes: "",
      comments: "",
      shares: "",
      saved: "",
      reach: "",
    });
  };
  const manualMetrics = () => ({
    total_interactions: Number(manualInteractions) || 0,
    views: Number(manualViews) || 0,
    follows: Number(manualFollows) || 0,
    ...Object.fromEntries(
      Object.entries(manualExtraMetrics).map(([key, value]) => [
        key,
        Number(value) || 0,
      ]),
    ),
  });
  const startEditManual = (post: MediaPost) => {
    setEditingManualId(post.id);
    setManualCaption(post.caption ?? "");
    setManualMediaUrl(post.thumbnailUrl ?? "");
    setManualInteractions(String(post.metrics.total_interactions ?? ""));
    setManualViews(String(post.metrics.views ?? ""));
    setManualFollows(String(post.metrics.follows ?? ""));
    setManualExtraMetrics({
      likes: String(post.metrics.likes ?? ""),
      comments: String(post.metrics.comments ?? ""),
      shares: String(post.metrics.shares ?? ""),
      saved: String(post.metrics.saved ?? ""),
      reach: String(post.metrics.reach ?? ""),
    });
  };
  const saveManualEdit = () => {
    if (!editingManualId) return;
    const metrics = manualMetrics();
    setManualPosts((current) =>
      current.map((post) =>
        post.id === editingManualId
          ? {
              ...post,
              caption: manualCaption.trim() || null,
              thumbnailUrl: manualMediaUrl.trim() || null,
              mediaUrl: manualMediaUrl.trim() || null,
              metrics: { ...post.metrics, ...metrics },
              score:
                metrics.total_interactions + metrics.views + metrics.follows,
            }
          : post,
      ),
    );
    setEditingManualId(null);
    resetManualForm();
  };
  const addManualPost = () => {
    const metrics = manualMetrics();
    const post: MediaPost = {
      id: `manual-${Date.now()}`,
      caption: manualCaption.trim() || null,
      mediaType: "IMAGE",
      mediaUrl: manualMediaUrl.trim() || null,
      thumbnailUrl: manualMediaUrl.trim() || null,
      permalink: null,
      publishedAt: periodEnd,
      metrics,
      score: metrics.total_interactions + metrics.views + metrics.follows,
    };
    setManualPosts((current) => [...current, post]);
    setSelectedManual((current) => [...current, post.id]);
    resetManualForm();
  };
  const removeManualPost = (id: string) => {
    setManualPosts((current) => current.filter((post) => post.id !== id));
    setSelectedManual((current) => current.filter((itemId) => itemId !== id));
    if (editingManualId === id) setEditingManualId(null);
  };
  const totalSelected = selected.length + selectedManual.length;
  const manualMessage =
    "لا يمكن إنشاء هذه الفترة التقريرية تلقائياً. يُرجى إضافة البيانات يدوياً.";
  const coverageNotice =
    coverage && coverage.status !== "COMPLETE" ? (
      <div className="media-manual-notice">
        <AlertCircle size={32} />
        <p>{coverage.warnings[0] ?? manualMessage}</p>
        {coverage.status === "UNAVAILABLE" || coverage.status === "FAILED" ? (
          <button className="btn accent" onClick={() => setMode("manual")}>
            إضافة منشور يدوياً
          </button>
        ) : coverage.status === "SYNCING" ? (
          <button
            className="btn quiet"
            disabled={syncing}
            onClick={() => void sync()}
          >
            <RefreshCw size={15} />
            {syncing ? "جارٍ التحديث..." : "تحديث من Meta"}
          </button>
        ) : null}
      </div>
    ) : null;
  const syncedBody = loading ? (
    <p>جارٍ تحميل المنشورات...</p>
  ) : displayedPosts.length === 0 ? (
    <>
      {coverageNotice ?? (
        <p>
          لا توجد منشورات في هذه الفترة. حدّثي البيانات من Meta أو جرّبي فترة
          أقرب.
        </p>
      )}
    </>
  ) : (
    <>
      {coverageNotice}
      <div className="media-library-grid">
        {displayedPosts.map((post) => (
          <button
            className={selected.includes(post.id) ? "selected" : ""}
            key={post.id}
            style={{ position: "relative" }}
            onClick={() =>
              setSelected((current) =>
                current.includes(post.id)
                  ? current.filter((id) => id !== post.id)
                  : [...current, post.id],
              )
            }
          >
            {(post.thumbnailUrl ?? post.mediaUrl) && (
              <img src={post.thumbnailUrl ?? post.mediaUrl ?? ""} alt="" />
            )}
            {post.isCollaborative && <span className="media-collab-badge">مشترك</span>}
            <MediaMetrics metrics={post.metrics} />
            <small>{post.caption?.slice(0, 45) || "منشور إنستغرام"}</small>
          </button>
        ))}
      </div>
    </>
  );
  const manualBody = (
    <div className="manual-post-panel">
      <div className="manual-post-section">
        <h3>رابط إنستغرام</h3>
        <p>ألصقي رابط المشاركة من إنستغرام لاستيراد الصورة والبيانات.</p>
        <div className="url-resolve">
          <input
            value={instagramUrl}
            onChange={(event) => setInstagramUrl(event.target.value)}
            placeholder="https://www.instagram.com/p/..."
          />
          <button
            className="btn accent"
            disabled={resolvingUrl || !instagramUrl.trim()}
            onClick={() => void resolveUrl()}
          >
            {resolvingUrl ? "جارٍ الاستيراد..." : "استيراد"}
          </button>
        </div>
        {urlError && <p className="manual-error">{urlError}</p>}
      </div>
      <div className="manual-post-section">
        <h3>رفع صورة من الجهاز</h3>
        <p>اختياري — ارفعي صورة المنشور مباشرة.</p>
        <input
          type="file"
          accept="image/*"
          onChange={(event) => uploadFile(event.target.files?.[0] ?? null)}
        />
        {uploadError && <p className="manual-error">{uploadError}</p>}
        {manualMediaUrl && (
          <img className="upload-preview" src={manualMediaUrl} alt="" />
        )}
      </div>
      <div className="manual-post-form">
        <h3>بيانات المنشور</h3>
        <p>
          {editingManualId
            ? "عدّلي بيانات المنشور المختار."
            : "أكملي البيانات الظاهرة في التقرير."}
        </p>
        <label>
          وصف المنشور
          <input
            value={manualCaption}
            onChange={(event) => setManualCaption(event.target.value)}
            placeholder="نص المنشور"
          />
        </label>
        <label>
          أو رابط صورة خارجي
          <input
            value={manualMediaUrl}
            onChange={(event) => setManualMediaUrl(event.target.value)}
            placeholder="https://..."
          />
        </label>
        <div className="manual-metrics">
          <label>
            التفاعلات
            <input
              type="number"
              min={0}
              value={manualInteractions}
              onChange={(event) => setManualInteractions(event.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            المشاهدات
            <input
              type="number"
              min={0}
              value={manualViews}
              onChange={(event) => setManualViews(event.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            المتابعون الجدد
            <input
              type="number"
              min={0}
              value={manualFollows}
              onChange={(event) => setManualFollows(event.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            الإعجابات
            <input
              type="number"
              min={0}
              value={manualExtraMetrics.likes}
              onChange={(event) =>
                setManualExtraMetrics((current) => ({
                  ...current,
                  likes: event.target.value,
                }))
              }
              placeholder="0"
            />
          </label>
          <label>
            التعليقات
            <input
              type="number"
              min={0}
              value={manualExtraMetrics.comments}
              onChange={(event) =>
                setManualExtraMetrics((current) => ({
                  ...current,
                  comments: event.target.value,
                }))
              }
              placeholder="0"
            />
          </label>
          <label>
            المشاركات
            <input
              type="number"
              min={0}
              value={manualExtraMetrics.shares}
              onChange={(event) =>
                setManualExtraMetrics((current) => ({
                  ...current,
                  shares: event.target.value,
                }))
              }
              placeholder="0"
            />
          </label>
          <label>
            الحفظ
            <input
              type="number"
              min={0}
              value={manualExtraMetrics.saved}
              onChange={(event) =>
                setManualExtraMetrics((current) => ({
                  ...current,
                  saved: event.target.value,
                }))
              }
              placeholder="0"
            />
          </label>
          <label>
            الوصول
            <input
              type="number"
              min={0}
              value={manualExtraMetrics.reach}
              onChange={(event) =>
                setManualExtraMetrics((current) => ({
                  ...current,
                  reach: event.target.value,
                }))
              }
              placeholder="0"
            />
          </label>
        </div>
        <div className="manual-form-actions">
          {editingManualId ? (
            <>
              <button
                className="btn quiet"
                onClick={() => setEditingManualId(null)}
              >
                إلغاء
              </button>
              <button className="btn primary" onClick={saveManualEdit}>
                <Save size={16} />
                حفظ التعديل
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              disabled={!manualCaption.trim() || !manualMediaUrl.trim()}
              onClick={addManualPost}
            >
              <Plus size={16} />
              إضافة
            </button>
          )}
        </div>
      </div>
      {manualPosts.length > 0 && (
        <div className="manual-posts-list">
          <h4>منشورات مضافة</h4>
          <div className="media-library-grid">
            {manualPosts.map((post) => (
              <button
                className={selectedManual.includes(post.id) ? "selected" : ""}
                key={post.id}
                onClick={() =>
                  setSelectedManual((current) =>
                    current.includes(post.id)
                      ? current.filter((id) => id !== post.id)
                      : [...current, post.id],
                  )
                }
              >
                {(post.thumbnailUrl ?? post.mediaUrl) && (
                  <img src={post.thumbnailUrl ?? post.mediaUrl ?? ""} alt="" />
                )}
                <MediaMetrics metrics={post.metrics} />
                <small>{post.caption?.slice(0, 45) || "منشور يدوي"}</small>
                <span className="manual-badge">يدوي</span>
                <span className="manual-actions">
                  <span
                    className="mini"
                    onClick={(event) => {
                      event.stopPropagation();
                      startEditManual(post);
                    }}
                  >
                    <Settings size={12} />
                  </span>
                  <span
                    className="mini danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeManualPost(post.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
  return (
    <div className="modal-backdrop">
      <section className="media-library card" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>مكتبة منشورات العميل</h2>
            <p>
              {mode === "synced"
                ? coverage
                  ? `منشورات الفترة المحددة مرتبة حسب ${filterLabels[sortBy]}. · ${coverage.status === "COMPLETE" ? "بيانات كاملة" : (coverage.warnings[0] ?? "جارٍ التحقق من التغطية")}`
                  : "جارٍ التحقق من تغطية البيانات..."
                : "استيراد أو رفع صورة المنشور وإدخال بياناته."}
            </p>
          </div>
          <button className="mini" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="media-library-tabs">
          <button
            className={mode === "synced" ? "active" : ""}
            onClick={() => setMode("synced")}
          >
            من Meta
          </button>
          <button
            className={mode === "manual" ? "active" : ""}
            onClick={() => setMode("manual")}
          >
            إضافة يدوياً
          </button>
        </div>
        <div className="media-library-actions">
          {mode === "synced" && (
            <>
              <button
                className="btn quiet compact"
                onClick={() => void sync()}
                disabled={syncing}
              >
                <RefreshCw size={15} />
                {syncing ? "جارٍ التحديث..." : "تحديث من Meta"}
              </button>
              <label className="media-filter">
                ترتيب
                <select
                  value={sortBy}
                  disabled={!coverageReady}
                  onChange={(event) =>
                    setSortBy(event.target.value as typeof sortBy)
                  }
                >
                  {Object.entries(filterLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <span>{totalSelected} منشورات مختارة</span>
        </div>
        {mode === "synced" ? syncedBody : manualBody}
        <div className="modal-actions">
          <span>
            {mode === "synced" &&
            coverage &&
            (coverage.status === "UNAVAILABLE" || coverage.status === "FAILED")
              ? manualMessage
              : "سيتم إلحاق المنشورات المختارة بالمنشورات الحالية في الصفحة."}
          </span>
          <div>
            <button className="btn quiet" onClick={onClose}>
              إلغاء
            </button>
            <button
              className="btn primary"
              disabled={totalSelected === 0}
              onClick={() =>
                onSelect([
                  ...posts.filter((post) => selected.includes(post.id)),
                  ...manualPosts.filter((post) =>
                    selectedManual.includes(post.id),
                  ),
                ])
              }
            >
              <Plus size={16} />
              إضافة إلى الصفحة
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function chartValues(kpi: Kpi, count = 17) {
  const seed = [...`${kpi.id}-${kpi.label}`].reduce(
    (total, character) => (total * 31 + character.charCodeAt(0)) >>> 0,
    7,
  );
  const total = Number(kpi.value.replace(/[^0-9.]/g, "")) || 0;
  const baseline = Math.max(total / count, 1);
  return Array.from({ length: count }, (_, index) => {
    const wave = Math.sin((index + 1) * ((seed % 5) + 1)) * 0.22;
    const variation = (((seed >> (index % 16)) & 15) - 7) / 25;
    const growth = ((index / Math.max(count - 1, 1)) * ((seed % 9) - 3)) / 18;
    return Math.max(1, Math.round(baseline * (1 + wave + variation + growth)));
  });
}

function MetricTrendChart({
  kpi,
  periodType,
  onDisplayChange,
}: {
  kpi: Kpi;
  periodType: ReportPeriod;
  onDisplayChange: (value: MetricPresentation) => void;
}) {
  const total = Number(kpi.value.replace(/[^0-9.]/g, "")) || 0;
  const axisLabels =
    periodType === "monthly"
      ? ["1", "15", "آخر الشهر"]
      : periodType === "quarterly"
        ? ["الشهر 1", "الشهر 2", "الشهر 3"]
        : periodType === "halfYearly"
          ? ["الشهر 1", "الشهر 3", "الشهر 6"]
          : ["يناير", "يونيو", "ديسمبر"];
  const values = chartValues(kpi);
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => `${32 + index * 15},${120 - (value / max) * 90}`)
    .join(" ");
  const color =
    [...kpi.id].reduce(
      (total, character) => total + character.charCodeAt(0),
      0,
    ) % 2
      ? "#ff5001"
      : "#3c0b5e";
  return (
    <div className="metric-trend-chart">
      <div className="metric-trend-head">
        <div>
          <span>{kpi.label}</span>
          <strong>{kpi.value}</strong>
        </div>
        <select
          value={kpi.display}
          onChange={(event) =>
            onDisplayChange(event.target.value as MetricPresentation)
          }
        >
          <option value="cards">بطاقة رقم</option>
          <option value="line">رسم خطي</option>
          <option value="bar">رسم أعمدة</option>
        </select>
      </div>
      <svg viewBox="0 0 300 150" role="img" aria-label={kpi.label}>
        <g className="chart-grid">
          <line x1="32" y1="30" x2="288" y2="30" />
          <line x1="32" y1="75" x2="288" y2="75" />
          <line x1="32" y1="120" x2="288" y2="120" />
        </g>
        <text x="5" y="34">
          {max.toLocaleString()}
        </text>
        <text x="5" y="79">
          {Math.round(max / 2).toLocaleString()}
        </text>
        <text x="13" y="124">
          0
        </text>
        {kpi.display === "line" ? (
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          values.map((value, index) => (
            <rect
              key={index}
              x={30 + index * 15}
              y={120 - (value / max) * 90}
              width="9"
              height={(value / max) * 90}
              rx="2"
              fill={color}
            />
          ))
        )}
        <text x="32" y="143">
          {axisLabels[0]}
        </text>
        <text x="125" y="143">
          {axisLabels[1]}
        </text>
        <text x="235" y="143">
          {axisLabels[2]}
        </text>
      </svg>
      <small>
        Instagram · {kpi.label} · {total.toLocaleString()}
      </small>
    </div>
  );
}

function PlatformMetricChart({
  kpis,
  presentation,
}: {
  kpis: Kpi[];
  presentation: Exclude<MetricPresentation, "cards">;
}) {
  const values = kpis.map(
    (kpi) => Number(kpi.value.replace(/[^0-9.]/g, "")) || 0,
  );
  const max = Math.max(...values, 1);
  const points = values
    .map(
      (value, index) =>
        `${20 + index * (260 / Math.max(values.length - 1, 1))},${130 - (value / max) * 100}`,
    )
    .join(" ");
  return (
    <div className="platform-metric-chart">
      <svg viewBox="0 0 300 150" role="img" aria-label="Platform metric chart">
        {presentation === "line" ? (
          <polyline
            points={points}
            fill="none"
            stroke="#ff5001"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          values.map((value, index) => (
            <rect
              key={kpis[index].id}
              x={18 + index * (264 / Math.max(values.length, 1))}
              y={130 - (value / max) * 100}
              width={Math.max(12, 210 / Math.max(values.length, 1))}
              height={(value / max) * 100}
              rx="3"
              fill="#ff5001"
            />
          ))
        )}
      </svg>
      <div>
        {kpis.map((kpi) => (
          <span key={kpi.id}>{kpi.label}</span>
        ))}
      </div>
    </div>
  );
}

function ChartGraphic({ chart }: { chart: ChartConfig }) {
  const values = chart.values
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  const max = Math.max(...values, 1);
  const axisMax = Math.ceil(max / 5) * 5 || 5;
  const labels =
    chart.labels
      ?.split(",")
      .map((label) => label.trim())
      .filter(Boolean) ?? [];
  const labelAt = (index: number) => {
    const label = labels[index];
    if (!label) return String(index + 1);
    const date = new Date(`${label}T00:00:00`);
    return Number.isNaN(date.valueOf())
      ? label
      : new Intl.DateTimeFormat("en", {
          month: "short",
          day: "numeric",
        }).format(date);
  };
  const x = (index: number) =>
    40 + index * (242 / Math.max(values.length - 1, 1));
  const y = (value: number) => 122 - (value / axisMax) * 94;
  const points = values
    .map((value, index) => `${x(index)},${y(value)}`)
    .join(" ");
  const ticks = [0, Math.round(axisMax / 2), axisMax];
  const labelIndexes = [
    ...new Set(
      Array.from(
        { length: Math.min(6, Math.max(values.length, 1)) },
        (_, index) =>
          Math.round(
            (index * Math.max(values.length - 1, 0)) /
              Math.max(Math.min(6, Math.max(values.length, 1)) - 1, 1),
          ),
      ),
    ),
  ];
  return (
    <div className="chart-preview">
      <div className="chart-preview-head">
        <span>{chart.metric}</span>
        <strong>
          {values.reduce((sum, value) => sum + value, 0).toLocaleString()}
        </strong>
      </div>
      <svg viewBox="0 0 300 160" role="img" aria-label={chart.metric}>
        <g className="chart-grid">
          {ticks.map((tick) => (
            <line key={tick} x1="40" y1={y(tick)} x2="282" y2={y(tick)} />
          ))}
        </g>
        <line className="chart-axis" x1="40" y1="122" x2="282" y2="122" />
        <line className="chart-axis" x1="40" y1="28" x2="40" y2="122" />
        {ticks.map((tick) => (
          <text className="chart-y-label" key={tick} x="34" y={y(tick) + 3}>
            {tick.toLocaleString()}
          </text>
        ))}
        {chart.type === "line" ? (
          <polyline
            points={points}
            fill="none"
            stroke="#ff5001"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          values.map((value, index) => (
            <rect
              key={index}
              x={x(index) - Math.min(12, 150 / Math.max(values.length, 1)) / 2}
              y={y(value)}
              width={Math.min(12, 150 / Math.max(values.length, 1))}
              height={122 - y(value)}
              rx="2"
              fill="#ff5001"
            />
          ))
        )}
        {labelIndexes.map((index) => (
          <text className="chart-x-label" key={index} x={x(index)} y="144">
            {labelAt(index)}
          </text>
        ))}
      </svg>
      <div className="chart-legend">
        <i />
        Instagram {chart.metric}
      </div>
    </div>
  );
}

function ChartEditor({
  chart,
  onChange,
}: {
  chart: ChartConfig;
  onChange: (field: keyof ChartConfig, value: string) => void;
}) {
  return (
    <div className="chart-editor">
      <div className="chart-settings">
        <label>
          نوع الرسم
          <select
            value={chart.type}
            onChange={(event) => onChange("type", event.target.value)}
          >
            <option value="line">خطي</option>
            <option value="bar">أعمدة</option>
          </select>
        </label>
        <label>
          المؤشر المعروض
          <input
            value={chart.metric}
            onChange={(event) => onChange("metric", event.target.value)}
          />
        </label>
        <label>
          القيم (افصلي بينها بفاصلة)
          <input
            value={chart.values}
            onChange={(event) => onChange("values", event.target.value)}
          />
        </label>
        <label>
          تسميات المحور الأفقي
          <input
            value={chart.labels ?? ""}
            onChange={(event) => onChange("labels", event.target.value)}
            placeholder="2026-04-01, 2026-04-02"
          />
        </label>
      </div>
      <ChartGraphic chart={chart} />
      <label className="chart-insight">
        الملاحظة التحليلية
        <textarea
          value={chart.insight}
          onChange={(event) => onChange("insight", event.target.value)}
          rows={3}
          placeholder="أضيفي أهم ملاحظة يوضحها الرسم البياني."
        />
      </label>
    </div>
  );
}

function MonthlySummaryEditor({
  summary,
  t,
  onChange,
}: {
  summary: MonthlySummary;
  t: Dictionary;
  onChange: (field: keyof MonthlySummary, value: string) => void;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const fields: Array<{
    key: keyof MonthlySummary;
    label: string;
    placeholder: string;
  }> = arabic
    ? [
        {
          key: "achievements",
          label: "أبرز الإنجازات",
          placeholder: "ما النتائج أو الأهداف التي تحققت هذا الشهر؟",
        },
        {
          key: "highlights",
          label: "أهم المبادرات والمحتوى",
          placeholder: "اذكري الحملات أو المحتوى أو الأحداث البارزة.",
        },
        {
          key: "challenges",
          label: "التحديات وفرص التحسين",
          placeholder: "اذكري ما يحتاج إلى تحسين في الشهر القادم.",
        },
      ]
    : [
        {
          key: "achievements",
          label: "Key achievements",
          placeholder: "What results or goals were achieved this month?",
        },
        {
          key: "highlights",
          label: "Campaign & content highlights",
          placeholder: "Add noteworthy campaigns, content, or events.",
        },
        {
          key: "challenges",
          label: "Challenges & opportunities",
          placeholder: "Note what needs improvement next month.",
        },
      ];
  return (
    <div className="summary-editor">
      {fields.map(({ key, label, placeholder }) => (
        <label key={key}>
          <span>{label}</span>
          <textarea
            value={summary[key]}
            onChange={(event) => onChange(key, event.target.value)}
            placeholder={placeholder}
            rows={3}
          />
        </label>
      ))}
    </div>
  );
}

function ReportSetup({
  t,
  clients,
  template,
  metadata,
  onClose,
  onCreate,
}: {
  t: Dictionary;
  clients: WorkspaceClient[];
  template: "standard" | "blank";
  metadata: ReportMetadata;
  onClose: () => void;
  onCreate: (metadata: ReportMetadata) => Promise<void>;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const [form, setForm] = useState(metadata);
  const periodOptions: Array<{ value: ReportPeriod; label: string }> = arabic
    ? [
        { value: "monthly", label: "شهري" },
        { value: "quarterly", label: "ربع سنوي" },
        { value: "halfYearly", label: "نصف سنوي" },
        { value: "yearly", label: "سنوي" },
      ]
    : [
        { value: "monthly", label: "Monthly" },
        { value: "quarterly", label: "Quarterly" },
        { value: "halfYearly", label: "Half-yearly" },
        { value: "yearly", label: "Yearly" },
      ];
  const setPeriod = (periodType: ReportPeriod) => {
    const period = completedPeriod(periodType);
    setForm((current) => {
      const client = clients.find((item) => item.id === current.clientId);
      const title = arabic
        ? `تقرير ${period.label}${client ? ` — ${client.name}` : ""}`
        : `${periodOptions.find((item) => item.value === periodType)?.label} report${client ? ` — ${client.name}` : ""}`;
      return {
        ...current,
        periodType,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        title,
      };
    });
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="report-setup card" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{arabic ? "إعداد التقرير" : "Report setup"}</h2>
            <p>
              {arabic
                ? "اختاري العميل ونوع الفترة. تُحتسب الفترات المكتملة تلقائياً."
                : "Choose the client and reporting period. Completed periods are calculated automatically."}
            </p>
          </div>
          <button className="mini" onClick={onClose} aria-label={t.cancel}>
            <X size={17} />
          </button>
        </div>
        <fieldset className="report-periods">
          <legend>{arabic ? "فترة التقرير" : "Report period"}</legend>
          {periodOptions.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="report-period"
                checked={form.periodType === option.value}
                onChange={() => setPeriod(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <div className="setup-fields">
          <label>
            {arabic ? "العميل" : "Client"}
            <select
              value={form.clientId ?? ""}
              onChange={(event) => {
                const clientId = event.target.value;
                const period = completedPeriod(form.periodType);
                const client = clients.find((item) => item.id === clientId);
                setForm((current) => ({
                  ...current,
                  clientId,
                  title: arabic
                    ? `تقرير ${period.label}${client ? ` — ${client.name}` : ""}`
                    : `${form.periodType} report${client ? ` — ${client.name}` : ""}`,
                }));
              }}
              required
            >
              <option value="">
                {arabic ? "اختاري العميل" : "Select client"}
              </option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <div className="fixed-period">
            <span>{arabic ? "الفترة المعتمدة" : "Selected period"}</span>
            <b>
              {form.periodStart} — {form.periodEnd}
            </b>
          </div>
        </div>
        <div className="modal-actions">
          <span>
            {template === "standard"
              ? arabic
                ? "القالب الشهري"
                : "Monthly template"
              : t.blank}
          </span>
          <div>
            <button className="btn quiet" onClick={onClose}>
              {t.cancel}
            </button>
            <button
              className="btn primary"
              disabled={!form.clientId}
              onClick={() => void onCreate(form)}
            >
              <FileText size={16} />
              {t.create}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="modal-backdrop approval-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <section className="card approval-dialog confirm-dialog">
        <h2 id="confirm-dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="approval-dialog-actions">
          <button className="btn quiet" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className="btn danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function ApprovalOverrideDialog({
  issues,
  onCancel,
  onConfirm,
}: {
  issues: string[];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <div
      className="modal-backdrop approval-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-override-title"
    >
      <section className="card approval-dialog">
        <h2 id="approval-override-title">التقرير غير جاهز للاعتماد</h2>
        <p>راجعي العناصر التالية أو اكتبي سبباً واضحاً للتجاوز.</p>
        <ul>
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
        <label>
          سبب التجاوز
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="مثال: تمت مراجعة البيانات مع العميل وسيتم استكمال التوصيات لاحقاً."
            autoFocus
          />
        </label>
        <div className="approval-dialog-actions">
          <button className="btn quiet" onClick={onCancel}>
            إلغاء
          </button>
          <button
            className="btn primary"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            اعتماد مع التجاوز
          </button>
        </div>
      </section>
    </div>
  );
}

function ReportPreview({
  t,
  reportId,
  reportTitle,
  clientId,
  periodStart,
  periodEnd,
  clientLogo,
  blocks,
  onClose,
}: {
  t: Dictionary;
  reportId: string | null;
  reportTitle: string;
  clientId: string | null;
  periodStart: string;
  periodEnd: string;
  clientLogo?: string | null;
  blocks: Block[];
  onClose: () => void;
}) {
  const [orientation, setOrientation] = useState<"landscape" | "portrait">(
    "landscape",
  );
  const [coverage, setCoverage] = useState<CoverageState | null>(null);
  useEffect(() => {
    if (!clientId) {
      setCoverage(null);
      return;
    }
    fetch(
      `/api/clients/${clientId}/coverage?periodStart=${periodStart}&periodEnd=${periodEnd}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { coverage?: CoverageState } | null) =>
        setCoverage(data?.coverage ?? null),
      )
      .catch(() => setCoverage(null));
  }, [clientId, periodStart, periodEnd]);
  const printReport = async () => {
    if (reportId)
      await fetch(`/api/reports/${reportId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation }),
      });
    const originalTitle = document.title;
    document.title = reportTitle;
    window.addEventListener(
      "afterprint",
      () => {
        document.title = originalTitle;
      },
      { once: true },
    );
    window.print();
  };
  return (
    <div className="report-preview-backdrop">
      <style media="print">{`@page { size: A4 ${orientation}; margin: 0; }`}</style>
      <section className={`report-preview ${orientation}`} dir="rtl">
        <div className="report-preview-actions">
          <button className="btn quiet" onClick={onClose}>
            <X size={16} />
            {t.cancel}
          </button>
          <div className="orientation-picker" aria-label="اتجاه PDF">
            <button
              className={orientation === "landscape" ? "active" : ""}
              onClick={() => setOrientation("landscape")}
            >
              أفقي
            </button>
            <button
              className={orientation === "portrait" ? "active" : ""}
              onClick={() => setOrientation("portrait")}
            >
              عمودي
            </button>
          </div>
          <button className="btn primary" onClick={printReport}>
            <FileText size={16} />
            {t.previewExport}
          </button>
        </div>
        <article className="print-report">
          <header className="print-cover">
            <div className="cover-logos">
              <div className="print-logo">
                <img
                  src="/Kaan-orange-logo.png"
                  alt="Kaan Creative"
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />
                <strong>
                  KAAN
                  <br />
                  CREATIVE
                </strong>
              </div>
              {clientLogo && (
                <div className="client-cover-logo">
                  <img src={clientLogo} alt="شعار العميل" />
                </div>
              )}
            </div>
            <div>
              <h1>{reportTitle}</h1>
              <p>
                {t.instagram} · {periodStart}
              </p>
            </div>
          </header>
          {coverage && coverage.status !== "COMPLETE" && (
            <section
              className="print-coverage-notice"
              style={{
                background: "#fff2eb",
                border: "1px solid #ffcbb5",
                padding: "16px 24px",
                margin: "12px 24px 0",
                borderRadius: "8px",
                color: "#7f3212",
              }}
            >
              <b>⚠ بيانات جزئية</b>
              <ul>
                {coverage.warnings.slice(0, 3).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}
          <main className="print-content">
            {blocks
              .filter((block) => block.page !== "cover")
              .map((block) => (
                <section className="print-section" key={block.id}>
                  <h2>{block.title}</h2>
                  {block.kind === "kpi" && block.kpis ? (
                    <div className="print-kpi-grid">
                      {block.kpis.map((kpi) =>
                        kpi.display === "line" || kpi.display === "bar" ? (
                          <PrintMetricTrend key={kpi.id} kpi={kpi} />
                        ) : (
                          <div className="print-kpi" key={kpi.id}>
                            <span>{kpi.label}</span>
                            <strong>{kpi.value}</strong>
                            {kpi.change && <small>{kpi.change}</small>}
                          </div>
                        ),
                      )}
                    </div>
                  ) : block.kind === "media" ? (
                    <MediaPrint
                      items={block.mediaItems ?? []}
                      display={
                        block.mediaDisplay ??
                        mediaSectionConfig(block.title).display
                      }
                    />
                  ) : block.chart ? (
                    <ChartPrint chart={block.chart} />
                  ) : block.summary ? (
                    <MonthlySummaryPrint summary={block.summary} t={t} />
                  ) : (
                    <p>{block.body}</p>
                  )}
                  {block.pageNote && (
                    <div className="print-page-note">
                      <h3>ملاحظات وتوصيات</h3>
                      <p>{block.pageNote}</p>
                    </div>
                  )}
                </section>
              ))}
          </main>
          <footer className="print-footer">
            <span>KAAN CREATIVE</span>
            <span>{reportTitle}</span>
          </footer>
        </article>
      </section>
    </div>
  );
}

function PrintMetricTrend({ kpi }: { kpi: Kpi }) {
  const values = chartValues(kpi);
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => `${32 + index * 15},${120 - (value / max) * 90}`)
    .join(" ");
  const color =
    [...kpi.id].reduce(
      (total, character) => total + character.charCodeAt(0),
      0,
    ) % 2
      ? "#ff5001"
      : "#3c0b5e";
  return (
    <div className="print-metric-trend">
      <span>{kpi.label}</span>
      <strong>{kpi.value}</strong>
      <svg viewBox="0 0 300 150" role="img" aria-label={kpi.label}>
        <g>
          <line x1="32" y1="30" x2="288" y2="30" />
          <line x1="32" y1="75" x2="288" y2="75" />
          <line x1="32" y1="120" x2="288" y2="120" />
        </g>
        <text x="5" y="34">
          {max.toLocaleString()}
        </text>
        <text x="5" y="79">
          {Math.round(max / 2).toLocaleString()}
        </text>
        <text x="13" y="124">
          0
        </text>
        {kpi.display === "line" ? (
          <polyline
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="3"
          />
        ) : (
          values.map((value, index) => (
            <rect
              key={index}
              x={30 + index * 15}
              y={120 - (value / max) * 90}
              width="9"
              height={(value / max) * 90}
              fill={color}
            />
          ))
        )}
        <text x="32" y="143">
          1
        </text>
        <text x="125" y="143">
          15
        </text>
        <text x="235" y="143">
          30
        </text>
      </svg>
      <small>Instagram · {kpi.label}</small>
    </div>
  );
}

function MediaPrint({
  items,
  display = ["total_interactions", "views"],
}: {
  items: MediaPost[];
  display?: string[];
}) {
  const keys =
    display.includes("total_interactions") && display.includes("views")
      ? ["total_interactions", "views"]
      : display;
  return items.length === 0 ? (
    <p>لم يتم اختيار منشورات لهذه الصفحة.</p>
  ) : (
    <div className="print-media-grid">
      {items.map((item) => (
        <article key={item.id}>
          {(item.thumbnailUrl ?? item.mediaUrl) && (
            <img src={item.thumbnailUrl ?? item.mediaUrl ?? ""} alt="" />
          )}
          <div className="print-media-metrics">
            {keys.map((key) => (
              <span key={key}>
                <b>{(item.metrics[key] ?? 0).toLocaleString()}</b>
                <small>{metricLabels[key] ?? key}</small>
              </span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function ChartPrint({ chart }: { chart: ChartConfig }) {
  return (
    <div className="print-chart">
      <ChartGraphic chart={chart} />
      <p>{chart.insight}</p>
    </div>
  );
}

function MonthlySummaryPrint({
  summary,
  t,
}: {
  summary: MonthlySummary;
  t: Dictionary;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const fields: Array<{ key: keyof MonthlySummary; label: string }> = arabic
    ? [
        { key: "achievements", label: "أبرز الإنجازات" },
        { key: "highlights", label: "أهم المبادرات والمحتوى" },
        { key: "challenges", label: "التحديات وفرص التحسين" },
      ]
    : [
        { key: "achievements", label: "Key achievements" },
        { key: "highlights", label: "Campaign & content highlights" },
        { key: "challenges", label: "Challenges & opportunities" },
      ];
  return (
    <div className="print-summary">
      {fields.map(
        ({ key, label }) =>
          summary[key] && (
            <div key={key}>
              <h3>{label}</h3>
              <p>{summary[key]}</p>
            </div>
          ),
      )}
    </div>
  );
}

const kpiPickerIdMap: Record<MetricKey, string> = {
  followers: "followers",
  metricReach: "reach",
  metricTotalViews: "total-views",
  metricViews: "views",
  metricFollows: "follows",
  metricFollowersLost: "followers-lost",
  metricNetFollowerGrowth: "net-follower-growth",
  metricPosts: "posts",
  metricOwnedPosts: "owned-posts",
  metricCollabPosts: "collaborative-posts",
  metricInteractions: "total_interactions",
  metricLikes: "likes",
  metricComments: "comments",
  metricShares: "shares",
  metricSaves: "saved",
  metricMediaFollows: "media-follows",
  metricImpressions: "impressions",
  metricEngagementRate: "engagement-rate",
  metricProfileVisits: "profile-visits",
  metricLinkClicks: "link-clicks",
  metricReelsPlays: "reels-plays",
};
const kpiPickerReverseIdMap = Object.fromEntries(
  Object.entries(kpiPickerIdMap).map(([key, id]) => [id, key]),
) as Record<string, MetricKey>;

function KpiPicker({
  t,
  periodType,
  existingKpis,
  onClose,
  onAdd,
}: {
  t: Dictionary;
  periodType: ReportPeriod;
  existingKpis?: Kpi[];
  onClose: () => void;
  onAdd: (kpis: Kpi[], presentation: MetricPresentation) => void;
}) {
  const metricKeys = Object.keys(metricValues) as MetricKey[];
  const existingById = new Map((existingKpis ?? []).map((kpi) => [kpi.id, kpi]));
  const [selected, setSelected] = useState<MetricKey[]>(() =>
    existingKpis
      ? (existingKpis
          .map((kpi) => kpiPickerReverseIdMap[kpi.id])
          .filter(Boolean) as MetricKey[])
      : ["metricReach", "metricViews", "metricInteractions"],
  );
  const [presentation, setPresentation] = useState<MetricPresentation>("cards");
  const [customName, setCustomName] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [customChange, setCustomChange] = useState("");
  const [customKpis, setCustomKpis] = useState<Kpi[]>(
    () => existingKpis?.filter((kpi) => !kpiPickerReverseIdMap[kpi.id]) ?? [],
  );
  const toggleMetric = (key: MetricKey) =>
    setSelected((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  const addCustom = () => {
    if (!customName.trim() || !customValue.trim()) return;
    setCustomKpis((current) => [
      ...current,
      {
        id: `custom-${Date.now()}`,
        label: customName.trim(),
        value: customValue.trim(),
        change: customChange.trim(),
        display: presentation,
        custom: true,
      },
    ]);
    setCustomName("");
    setCustomValue("");
    setCustomChange("");
  };
  const removeCustom = (id: string) =>
    setCustomKpis((current) => current.filter((kpi) => kpi.id !== id));
  const idMap = kpiPickerIdMap;
  const submit = () => {
    const metrics = selected.map((key) => {
      const id = idMap[key];
      const existingKpi = existingById.get(id);
      return (
        existingKpi ?? {
          id,
          label: t[key],
          value: metricValues[key][0],
          change: metricValues[key][1],
          display: presentation,
        }
      );
    });
    onAdd([...metrics, ...customKpis], presentation);
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="kpi-modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="kpi-picker-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="kpi-picker-title">{t.chooseKpis}</h2>
            <p>{t.chooseKpisDesc}</p>
          </div>
          <button className="mini" aria-label={t.cancel} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="picker-platform">
          <span>{t.platform}</span>
          <div>
            <Instagram size={16} />
            {t.instagram}
          </div>
        </div>
        <fieldset className="picker-section">
          <legend>{t.metrics}</legend>
          <div className="metric-options">
            {metricKeys.map((key) => (
              <label className="metric-option" key={key}>
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  onChange={() => toggleMetric(key)}
                />
                <span>{t[key]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="picker-section">
          <legend>
            {t.dashboard === "الرئيسية" ? "طريقة العرض" : "Presentation"}
          </legend>
          <div className="presentation-options">
            {(["cards", "line", "bar"] as const).map((option) => (
              <label key={option}>
                <input
                  type="radio"
                  name="presentation"
                  checked={presentation === option}
                  onChange={() => setPresentation(option)}
                />
                {option === "cards"
                  ? t.dashboard === "الرئيسية"
                    ? "بطاقات أرقام"
                    : "Number cards"
                  : option === "line"
                    ? t.dashboard === "الرئيسية"
                      ? "رسم خطي"
                      : "Line chart"
                    : t.dashboard === "الرئيسية"
                      ? "رسم أعمدة"
                      : "Bar chart"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="picker-section custom-section">
          <legend>{t.customKpi}</legend>
          <p>{t.customKpiHint}</p>
          <div className="custom-fields">
            <input
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
              placeholder={t.kpiName}
            />
            <input
              value={customValue}
              onChange={(event) => setCustomValue(event.target.value)}
              placeholder={t.kpiValue}
            />
            <input
              value={customChange}
              onChange={(event) => setCustomChange(event.target.value)}
              placeholder={t.kpiChange}
            />
          </div>
          <button className="btn quiet compact" onClick={addCustom}>
            <Plus size={14} />
            {t.addCustom}
          </button>
          {customKpis.length > 0 && (
            <div className="custom-kpi-list">
              {customKpis.map((kpi) => (
                <span key={kpi.id}>
                  {kpi.label}: {kpi.value}
                  <button
                    type="button"
                    aria-label="Remove custom KPI"
                    onClick={() => removeCustom(kpi.id)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </fieldset>
        <div className="modal-actions">
          <span>
            {selected.length + customKpis.length} {t.selectedMetrics}
          </span>
          <div>
            <button className="btn quiet" onClick={onClose}>
              {t.cancel}
            </button>
            <button
              className="btn primary"
              disabled={selected.length + customKpis.length === 0}
              onClick={submit}
            >
              <Plus size={16} />
              {t.addSelected}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SignIn({
  language,
  onLanguageChange,
  onSignedIn,
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
  onSignedIn: (user: WorkspaceUser) => void;
}) {
  const rtl = language === "AR";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await response.json()) as {
      user?: WorkspaceUser;
      error?: string;
    };
    setSubmitting(false);
    if (!response.ok || !data.user) {
      setError(
        data.error ?? (rtl ? "تعذر تسجيل الدخول." : "Unable to sign in."),
      );
      return;
    }
    onSignedIn(data.user);
  };
  return (
    <main className="auth-shell" dir={rtl ? "rtl" : "ltr"}>
      <section className="auth-card">
        <div className="brand auth-brand">
          <img
            src="/Kaan-orange-logo.png"
            alt="KAAN Achievement Reports"
            className="brand-logo"
          />
        </div>
        <button
          className="lang auth-language"
          onClick={() => onLanguageChange(rtl ? "EN" : "AR")}
        >
          {rtl ? "English" : "العربية"}
        </button>
        <h1>{rtl ? "تسجيل الدخول" : "Sign in"}</h1>
        <p>
          {rtl
            ? "سجّلي الدخول للوصول إلى تقارير العملاء."
            : "Sign in to access your clients’ reports."}
        </p>
        <a className="btn quiet full-width auth-google" href="/api/auth/google">
          <Link2 size={16} />
          {rtl
            ? "تسجيل الدخول بحساب Google Workspace"
            : "Sign in with Google Workspace"}
        </a>
        <div className="auth-divider">
          <span>{rtl ? "أو" : "or"}</span>
        </div>
        <form onSubmit={submit}>
          <label>
            {rtl ? "البريد الإلكتروني" : "Email"}
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            {rtl ? "كلمة المرور" : "Password"}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              minLength={12}
              required
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary full-width" disabled={submitting}>
            {submitting
              ? rtl
                ? "جارٍ الدخول..."
                : "Signing in..."
              : rtl
                ? "دخول"
                : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}

function ClientWorkspace({
  t,
  clients,
  selectedClientId,
  onSelect,
  onRefresh,
  onCreated,
  user,
}: {
  t: Dictionary;
  clients: WorkspaceClient[];
  selectedClientId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => Promise<void>;
  onCreated: (client: WorkspaceClient) => Promise<void>;
  user: WorkspaceUser | null;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const createClientLabel = arabic ? "إنشاء عميل" : "Create client";
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [archived, setArchived] = useState<WorkspaceClient[]>([]);
  const [changing, setChanging] = useState<string | null>(null);
  const selectedClient = clients.find(
    (client) => client.id === selectedClientId,
  );
  const [logoUrl, setLogoUrl] = useState("");
  const [logoStatus, setLogoStatus] = useState("");
  const [confirmDeleteClient, setConfirmDeleteClient] =
    useState<WorkspaceClient | null>(null);
  const refreshArchived = async () => {
    const response = await fetch("/api/clients?archived=true");
    if (!response.ok) return;
    const data = (await response.json()) as { clients?: WorkspaceClient[] };
    setArchived(data.clients ?? []);
  };
  useEffect(() => {
    void refreshArchived();
  }, []);
  useEffect(() => {
    setLogoUrl(selectedClient?.logoUrl ?? "");
    setLogoStatus("");
  }, [selectedClient?.id, selectedClient?.logoUrl]);
  const addClient = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setError("");
    const response = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = (await response.json()) as {
      client?: WorkspaceClient;
      error?: string;
    };
    setSubmitting(false);
    if (!response.ok || !data.client) {
      setError(data.error ?? t.configuration);
      return;
    }
    setName("");
    await onCreated(data.client);
  };
  const saveLogo = async (url = logoUrl) => {
    if (!selectedClient) return false;
    setChanging(selectedClient.id);
    setLogoStatus("");
    const response = await fetch(`/api/clients/${selectedClient.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logoUrl: url }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(data.error ?? "تعذر حفظ شعار العميل.");
      setChanging(null);
      return false;
    }
    await onRefresh();
    setLogoStatus("تم حفظ الشعار وسيظهر في معاينة التقرير وتصدير PDF.");
    setChanging(null);
    return true;
  };
  const uploadLogo = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
      setError("اختاري شعاراً بصيغة صورة وحجمه أقل من 2 ميجابايت.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      setLogoUrl(url);
      void saveLogo(url);
    };
    reader.onerror = () => setError("تعذر قراءة الشعار.");
    reader.readAsDataURL(file);
  };
  const useMetaLogo = async () => {
    if (!selectedClient) return;
    setChanging(selectedClient.id);
    setError("");
    setLogoStatus("");
    const response = await fetch(`/api/clients/${selectedClient.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "meta-logo" }),
    });
    const data = (await response.json()) as {
      client?: { logoUrl?: string | null };
      error?: string;
    };
    if (!response.ok || !data.client?.logoUrl)
      setError(data.error ?? "تعذر جلب صورة حساب Instagram من Meta.");
    else {
      setLogoUrl(data.client.logoUrl);
      await onRefresh();
      setLogoStatus("تم استخدام صورة حساب Instagram من Meta في غلاف التقرير.");
    }
    setChanging(null);
  };
  const setArchivedState = async (clientId: string, active: boolean) => {
    setChanging(clientId);
    const response = await fetch(`/api/clients/${clientId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) setError(data.error ?? "تعذر تحديث العميل.");
    await Promise.all([onRefresh(), refreshArchived()]);
    setChanging(null);
  };
  const deleteClient = async (client: WorkspaceClient) => {
    setConfirmDeleteClient(null);
    setChanging(client.id);
    const response = await fetch(`/api/clients/${client.id}?confirm=true`, {
      method: "DELETE",
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) setError(data.error ?? "تعذر حذف العميل.");
    await refreshArchived();
    setChanging(null);
  };
  return (
    <section>
      <div className="hero">
        <div>
          <h1>{t.clients}</h1>
          <p>أضيفي العميل هنا، ثم اختاري حساباته من صفحة الحسابات المتصلة.</p>
        </div>
      </div>
      <div className="client-workspace">
        <aside className="card client-create">
          <h2>{createClientLabel}</h2>
          <p>{t.clients}</p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void addClient()}
            placeholder={t.clients}
          />
          <button
            className="btn primary full-width"
            disabled={submitting || !name.trim()}
            onClick={() => void addClient()}
          >
            <Plus size={16} />
            {createClientLabel}
          </button>
          {error && <small className="client-error">{error}</small>}
        </aside>
        <div className="client-list">
          {clients.length === 0 ? (
            <div className="empty-template">
              <div>
                <Users size={34} />
                <strong>{t.clients}</strong>
                <span>{t.comingSoon}</span>
              </div>
            </div>
          ) : (
            clients.map((client) => (
              <div
                className={`client-row card ${client.id === selectedClientId ? "selected" : ""}`}
                key={client.id}
              >
                <button
                  className="client-select"
                  onClick={() => onSelect(client.id)}
                >
                  <span className="client-avatar">
                    {client.logoUrl ? (
                      <img src={client.logoUrl} alt={client.name} />
                    ) : (
                      client.name.slice(0, 1)
                    )}
                  </span>
                  <span className="client-details">
                    <b>{client.name}</b>
                    <small>
                      {client.connections?.length ?? 0} {t.accounts} ·{" "}
                      {client._count?.reports ?? 0} {t.reports}
                    </small>
                  </span>
                  {client.id === selectedClientId && <CheckCircle2 size={19} />}
                </button>
                <button
                  className="btn quiet compact"
                  disabled={changing === client.id}
                  onClick={() => void setArchivedState(client.id, false)}
                >
                  أرشفة
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      {selectedClient && (
        <section className="card client-logo-settings">
          <div>
            <h2>شعار العميل في الغلاف</h2>
            <p>
              أضيفي شعاراً من جهازك أو ألصقي رابط صورة. يظهر بجانب شعار Kaan في
              التقرير.
            </p>
          </div>
          <div className="client-logo-controls">
            <button
              className="btn quiet compact"
              disabled={changing === selectedClient.id}
              onClick={() => void useMetaLogo()}
            >
              <Instagram size={16} />
              استخدام صورة Instagram
            </button>
            <input
              value={logoUrl}
              onChange={(event) => setLogoUrl(event.target.value)}
              placeholder="https://..."
            />
            <input
              type="file"
              accept="image/*"
              onChange={(event) => uploadLogo(event.target.files?.[0] ?? null)}
            />
            {logoUrl && <img src={logoUrl} alt="معاينة شعار العميل" />}
            <button
              className="btn primary"
              disabled={changing === selectedClient.id}
              onClick={() => void saveLogo()}
            >
              <Save size={16} />
              حفظ الشعار
            </button>
            {logoStatus && <small className="logo-status">{logoStatus}</small>}
          </div>
        </section>
      )}
      <section className="card archived-clients">
        <div className="card-title">
          <div>
            <h2>أرشيف العملاء</h2>
            <p>يمكنك استعادة العميل أو حذفه نهائياً من هنا.</p>
          </div>
        </div>
        {archived.length === 0 ? (
          <p className="account-empty">لا يوجد عملاء مؤرشفون.</p>
        ) : (
          archived.map((client) => (
            <div className="archived-client" key={client.id}>
              <div>
                <b>{client.name}</b>
                <small>
                  {client._count?.reports ?? 0} {t.reports}
                </small>
              </div>
              <div className="archived-actions">
                <button
                  className="btn quiet compact"
                  disabled={changing === client.id}
                  onClick={() => void setArchivedState(client.id, true)}
                >
                  استعادة
                </button>
                {hasFeature(user, "delete_clients") && (
                  <button
                    className="btn quiet compact danger-button"
                    disabled={changing === client.id}
                    onClick={() => setConfirmDeleteClient(client)}
                  >
                    <Trash2 size={14} />
                    حذف نهائياً
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </section>
      {confirmDeleteClient && (
        <ConfirmDialog
          title="حذف العميل نهائياً؟"
          message={`حذف ${confirmDeleteClient.name} نهائياً؟ سيتم حذف تقاريره وبياناته وحساباته المتزامنة ولا يمكن استعادتها.`}
          confirmLabel="حذف نهائياً"
          cancelLabel={t.cancel}
          onCancel={() => setConfirmDeleteClient(null)}
          onConfirm={() => void deleteClient(confirmDeleteClient)}
        />
      )}
    </section>
  );
}

const backfillLabels: Record<string, string> = {
  NOT_STARTED: "لم يبدأ",
  RUNNING: "جارٍ التحميل",
  PARTIAL: "جارٍ الاستكمال",
  COMPLETED: "مكتمل",
  FAILED: "فشل",
};

function DataHealth({
  connection,
}: {
  connection?: NonNullable<WorkspaceClient["connections"]>[number];
}) {
  if (!connection) return null;
  const job = connection.syncJobs?.[0];
  const runs = connection.syncRuns ?? [];
  return (
    <section className="data-health">
      <b>صحة البيانات</b>
      <span>
        آخر نجاح:{" "}
        {connection.lastSuccessfulSyncAt
          ? new Date(connection.lastSuccessfulSyncAt).toLocaleString()
          : "غير متاح"}
      </span>
      {connection.historicalBackfillStatus && (
        <span>
          التحميل التاريخي:{" "}
          {backfillLabels[connection.historicalBackfillStatus] ??
            connection.historicalBackfillStatus}
          {connection.historicalBackfillProcessedPosts
            ? ` · ${connection.historicalBackfillProcessedPosts} منشور`
            : ""}
          {connection.historicalBackfillLastError
            ? ` · ${connection.historicalBackfillLastError}`
            : ""}
        </span>
      )}
      {job && (
        <span>
          المهمة:{" "}
          {job.status === "QUEUED"
            ? "في قائمة الانتظار"
            : job.status === "RUNNING"
              ? "جارٍ التحديث"
              : job.status === "FAILED"
                ? "فشلت"
                : "مكتملة"}
          {job.status === "QUEUED" && ` · محاولة ${job.attempts + 1}`}
        </span>
      )}
      {runs.map((run, index) => (
        <span
          key={`${run.startedAt}-${index}`}
          className={run.status === "SUCCEEDED" ? "success" : "failed"}
        >
          {run.status === "SUCCEEDED"
            ? `نجحت: ${run.postsSynced} منشور${run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)} ث` : ""}`
            : `فشلت: ${run.errorMessage ?? "تعذر التحديث"}`}
        </span>
      ))}
    </section>
  );
}

function ConnectedAccounts({
  t,
  clients,
  onRefresh,
  user,
}: {
  t: Dictionary;
  clients: WorkspaceClient[];
  onRefresh: () => Promise<void>;
  user: WorkspaceUser | null;
}) {
  const [profiles, setProfiles] = useState<MetaProfile[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, SyncResult>>(
    {},
  );
  const [error, setError] = useState("");
  const canRunBackfill = hasFeature(user, "run_historical_sync");
  const refreshProfiles = async () => {
    const response = await fetch("/api/meta-accounts");
    if (!response.ok) return;
    const data = (await response.json()) as { profiles?: MetaProfile[] };
    setProfiles(data.profiles ?? []);
  };
  const [metaConfig, setMetaConfig] = useState({
    loginConfigIdConfigured: false,
    businessIdConfigured: false,
  });
  const refreshMetaConfig = async () => {
    const response = await fetch("/api/connectors/meta/config");
    if (!response.ok) return;
    const data = (await response.json()) as {
      loginConfigIdConfigured?: boolean;
      businessIdConfigured?: boolean;
    };
    setMetaConfig({
      loginConfigIdConfigured: data.loginConfigIdConfigured ?? false,
      businessIdConfigured: data.businessIdConfigured ?? false,
    });
  };
  useEffect(() => {
    void refreshProfiles();
    void refreshMetaConfig();
  }, []);
  const accounts = profiles.flatMap((profile) =>
    profile.accounts.map((account) => ({
      ...account,
      profileName: profile.displayName,
    })),
  );
  const selected = (
    client: WorkspaceClient,
    platform: "INSTAGRAM" | "FACEBOOK",
  ) =>
    client.connections?.find((connection) => connection.platform === platform)
      ?.sourceAccountId ?? "";
  const syncHealth = (client: WorkspaceClient) => {
    const connection = client.connections?.find(
      (item) => item.platform === "INSTAGRAM",
    );
    if (!connection)
      return { label: "لا يوجد حساب Instagram معيّن", state: "warn" };
    if (connection.lastFailureReason)
      return {
        label: `فشلت آخر مزامنة: ${connection.lastFailureReason}`,
        state: "warn",
      };
    if (!connection.lastSuccessfulSyncAt)
      return { label: "لم تتم مزامنة ناجحة بعد", state: "warn" };
    const age =
      Date.now() - new Date(connection.lastSuccessfulSyncAt).valueOf();
    if (
      connection.tokenExpiresAt &&
      new Date(connection.tokenExpiresAt).valueOf() - Date.now() <
        7 * 24 * 60 * 60 * 1000
    )
      return { label: "رمز Meta قريب من الانتهاء", state: "warn" };
    return age > 24 * 60 * 60 * 1000
      ? { label: "البيانات بحاجة إلى تحديث", state: "warn" }
      : {
          label: `آخر مزامنة ناجحة ${new Date(connection.lastSuccessfulSyncAt).toLocaleString()}`,
          state: "good",
        };
  };
  const assign = async (
    client: WorkspaceClient,
    platform: "INSTAGRAM" | "FACEBOOK",
    accountId: string,
  ) => {
    const otherPlatform = platform === "INSTAGRAM" ? "FACEBOOK" : "INSTAGRAM";
    const accountIds = [accountId, selected(client, otherPlatform)].filter(
      Boolean,
    );
    setSaving(client.id);
    setError("");
    const response = await fetch(`/api/clients/${client.id}/accounts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountIds }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) setError(data.error ?? "تعذر حفظ تعيين الحسابات.");
    await Promise.all([onRefresh(), refreshProfiles()]);
    setSaving(null);
  };
  const pollSyncStatus = async (
    clientId: string,
    attempt = 0,
  ): Promise<void> => {
    const response = await fetch("/api/clients");
    const data = response.ok
      ? ((await response.json()) as { clients?: WorkspaceClient[] })
      : { clients: [] };
    const client = data.clients?.find((item) => item.id === clientId);
    const active = client?.connections?.some((connection) =>
      connection.syncJobs?.some(
        (job) => job.status === "QUEUED" || job.status === "RUNNING",
      ),
    );
    await Promise.all([onRefresh(), refreshProfiles()]);
    if (active && attempt < 60) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return pollSyncStatus(clientId, attempt + 1);
    }
    if (active) {
      setError("لا تزال المزامنة قيد التشغيل. تحققي من صحة البيانات بعد قليل.");
      return;
    }
    const failedConnection = client?.connections?.find(
      (connection) =>
        connection.lastFailureReason &&
        connection.lastFailedSyncAt &&
        (!connection.lastSuccessfulSyncAt ||
          new Date(connection.lastFailedSyncAt) >
            new Date(connection.lastSuccessfulSyncAt)),
    );
    setError(
      failedConnection
        ? `اكتملت المزامنة مع أخطاء: ${failedConnection.lastFailureReason}`
        : "اكتملت المزامنة بنجاح.",
    );
  };
  const sync = async (clientId: string) => {
    setSyncing(clientId);
    setError("");
    try {
      const response = await fetch(`/api/clients/${clientId}/sync`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        jobs?: Array<{ id: string }>;
        error?: string;
      };
      if (!response.ok) {
        setError(result.error ?? "تعذر وضع التحديث في قائمة الانتظار.");
        return;
      }
      if (!result.jobs?.length) {
        setError("لا توجد حسابات مؤهلة للمزامنة لهذا العميل.");
        await Promise.all([onRefresh(), refreshProfiles()]);
        return;
      }
      setError(
        `تم وضع ${result.jobs.length} مزامنة في قائمة الانتظار. جارٍ التحديث...`,
      );
      await pollSyncStatus(clientId);
    } catch {
      setError("تعذر الاتصال بخدمة التحديث.");
    } finally {
      setSyncing(null);
    }
  };
  const backfillInProgress = (client?: WorkspaceClient) =>
    client?.connections?.some(
      (connection) =>
        connection.historicalBackfillStatus === "RUNNING" ||
        connection.historicalBackfillStatus === "PARTIAL" ||
        connection.syncJobs?.some(
          (job) =>
            job.type === "HISTORICAL_MEDIA_BACKFILL" &&
            (job.status === "QUEUED" || job.status === "RUNNING"),
        ),
    );
  const pollBackfillStatus = async (
    clientId: string,
    attempt = 0,
  ): Promise<void> => {
    const response = await fetch("/api/clients");
    const data = response.ok
      ? ((await response.json()) as { clients?: WorkspaceClient[] })
      : { clients: [] };
    const client = data.clients?.find((item) => item.id === clientId);
    await Promise.all([onRefresh(), refreshProfiles()]);
    const active = client ? backfillInProgress(client) : false;
    if (active && attempt < 60) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return pollBackfillStatus(clientId, attempt + 1);
    }
    if (active) {
      setError(
        "لا يزال التحميل التاريخي قيد التشغيل. تحققي من الحالة بعد قليل.",
      );
      return;
    }
    setError("اكتمل التحميل التاريخي.");
  };
  const backfill = async (clientId: string) => {
    setBackfilling(clientId);
    setError("");
    try {
      const response = await fetch(`/api/clients/${clientId}/backfill`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        jobs?: Array<{ id: string }>;
        error?: string;
      };
      if (!response.ok) {
        setError(result.error ?? "تعذر تشغيل التحميل التاريخي.");
        return;
      }
      if (!result.jobs?.length) {
        setError("لا توجد حسابات مؤهلة للتحميل التاريخي.");
        await Promise.all([onRefresh(), refreshProfiles()]);
        return;
      }
      setError("تم وضع التحميل التاريخي في قائمة الانتظار. جارٍ التحميل...");
      await pollBackfillStatus(clientId);
    } catch {
      setError("تعذر الاتصال بخدمة التحميل التاريخي.");
    } finally {
      setBackfilling(null);
    }
  };
  const backfillStatus = (client: WorkspaceClient) =>
    client.connections?.find((item) => item.platform === "INSTAGRAM")
      ?.historicalBackfillStatus;
  const canConnectSystemUser = hasFeature(user, "connect_meta_system_user");
  const [systemUserToken, setSystemUserToken] = useState("");
  const [systemUserPreview, setSystemUserPreview] = useState<{
    tokenPreview: string;
    pages: Array<{
      id: string;
      name: string;
      instagram: { id: string; username: string | null } | null;
    }>;
    adAccounts: Array<{ id: string; name: string }>;
    warnings?: string[];
  } | null>(null);
  const [systemUserBusy, setSystemUserBusy] = useState(false);
  const [systemUserError, setSystemUserError] = useState("");
  const [confirmDisconnectSystemUser, setConfirmDisconnectSystemUser] = useState(false);
  const submitSystemUserToken = async (confirm: boolean) => {
    setSystemUserBusy(true);
    setSystemUserError("");
    try {
      const response = await fetch("/api/connectors/meta/system-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: systemUserToken, confirm }),
      });
      const data = (await response.json()) as {
        preview?: typeof systemUserPreview;
        pagesConnected?: number;
        error?: string;
        errors?: string[];
      };
      if (!response.ok) {
        const errorList = data.errors?.length
          ? data.errors
          : data.error
            ? [data.error]
            : ["تعذر الاتصال بخدمة Meta."];
        setSystemUserError(errorList.join("\n"));
        return;
      }
      if (!confirm) {
        setSystemUserPreview(data.preview ?? null);
        return;
      }
      setSystemUserToken("");
      setSystemUserPreview(null);
      await Promise.all([onRefresh(), refreshProfiles()]);
    } catch {
      setSystemUserError("تعذر الاتصال بخدمة Meta.");
    } finally {
      setSystemUserBusy(false);
    }
  };
  const disconnectSystemUser = async () => {
    setSystemUserBusy(true);
    setSystemUserError("");
    try {
      const response = await fetch("/api/connectors/meta/system-user", {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        setSystemUserError(data.error ?? "تعذر فصل الربط.");
        return;
      }
      setSystemUserToken("");
      setSystemUserPreview(null);
      setConfirmDisconnectSystemUser(false);
      await Promise.all([onRefresh(), refreshProfiles()]);
    } catch {
      setSystemUserError("تعذر الاتصال بخدمة Meta.");
    } finally {
      setSystemUserBusy(false);
    }
  };
  const kaanSystemUserProfile = profiles.find(
    (profile) => profile.displayName === "Meta Business · Kaan Creative (System user)",
  );
  const totalMetaAssets = systemUserPreview
    ? systemUserPreview.pages.length + systemUserPreview.adAccounts.length
    : 0;
  return (
    <section>
      <div className="hero">
        <div>
          <h1>{t.accounts}</h1>
          <p>
            اربطي ملف Meta واحداً لـ Kaan، ثم عيّني حساب إنستغرام وفيسبوك
            الاختياري لكل عميل.
          </p>
        </div>
        {metaConfig.loginConfigIdConfigured && (
          <a className="btn accent" href="/api/connectors/meta">
            <Link2 size={16} />
            ربط ملف Meta جديد (عميل خارجي)
          </a>
        )}
      </div>
      {error && <div className="notice">{error}</div>}
      {canConnectSystemUser && (
        <section className="card system-user-connect">
          <div className="card-title">
            <div>
              <h2>
                <ShieldCheck size={16} /> ربط أصول Kaan Creative عبر رمز نظام
                Meta (للمدير)
              </h2>
              <p>
                لأصول Kaan Creative المملوكة داخل نفس التطبيق، لا يمكن استخدام
                تسجيل الدخول عبر Meta. الصقي هنا رمز System User الدائم من
                Business Settings بدلاً من ذلك. الزر أدناه يتحقق من صحة الرمز
                أولاً (اختبار الاتصال) ثم يعرض الأصول قبل الحفظ.
              </p>
            </div>
            {kaanSystemUserProfile && (
              <button
                className="btn danger compact"
                disabled={systemUserBusy}
                onClick={() => setConfirmDisconnectSystemUser(true)}
              >
                <Trash2 size={14} />
                فصل الربط المحلي
              </button>
            )}
          </div>
          {confirmDisconnectSystemUser && (
            <ConfirmDialog
              title="فصل ربط أصول Kaan Creative؟"
              message="سيُحذف التعيين المحلي فقط، ولن يُلغَى الرمز من Business Settings."
              confirmLabel="فصل الربط"
              cancelLabel="إلغاء"
              onCancel={() => setConfirmDisconnectSystemUser(false)}
              onConfirm={() => void disconnectSystemUser()}
            />
          )}
          {!metaConfig.businessIdConfigured && (
            <small className="client-error">
              لم يُضبط META_BUSINESS_ID في .env؛ أضيفي معرّف Business Portfolio
              أولاً.
            </small>
          )}
          {kaanSystemUserProfile && !systemUserPreview && (
            <small className="logo-status">
              يوجد ربط حالي ({kaanSystemUserProfile.accounts.length} حساب). لاستبدال الرمز، ألصقي الرمز الجديد أدناه ثم اختبريه.
            </small>
          )}
          <textarea
            value={systemUserToken}
            onChange={(event) => {
              setSystemUserToken(event.target.value.replace(/\s+/g, ""));
              setSystemUserPreview(null);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text").replace(/\s+/g, "");
              setSystemUserToken(pasted);
              setSystemUserPreview(null);
              event.preventDefault();
            }}
            placeholder="الصقي رمز System User هنا (يبدأ بـ EAA...)"
            rows={2}
          />
          {systemUserError && (
            <div className="system-user-error">
              <b>تعذر التحقق من الرمز:</b>
              <ul>
                {systemUserError.split("\n").map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {!systemUserPreview ? (
            <div className="actions">
              <button
                className="btn quiet compact"
                disabled={systemUserBusy || !systemUserToken.trim()}
                onClick={() => void submitSystemUserToken(false)}
              >
                {systemUserBusy ? "جارٍ التحقق..." : "اختبار الاتصال ومعاينة الأصول"}
              </button>
            </div>
          ) : (
            <>
              <small>الرمز: {systemUserPreview.tokenPreview}</small>
              <small>
                {totalMetaAssets} أصل Meta متاح ·{" "}
                {systemUserPreview.adAccounts.length} حساب إعلاني
              </small>
              {systemUserPreview.warnings &&
                systemUserPreview.warnings.length > 0 && (
                  <ul className="system-user-warnings">
                    {systemUserPreview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                )}
              <ul className="system-user-pages">
                {systemUserPreview.pages.map((page) => (
                  <li key={page.id}>
                    {page.name}
                    {page.instagram &&
                      ` — @${page.instagram.username ?? page.instagram.id}`}
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button
                  className="btn primary compact"
                  disabled={systemUserBusy}
                  onClick={() => void submitSystemUserToken(true)}
                >
                  {systemUserBusy
                    ? "جارٍ الربط..."
                    : kaanSystemUserProfile
                      ? "تأكيد استبدال الرمز"
                      : "تأكيد الربط"}
                </button>
                <button
                  className="btn quiet compact"
                  disabled={systemUserBusy}
                  onClick={() => setSystemUserPreview(null)}
                >
                  إلغاء
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <section className="meta-profiles">
        {profiles.length === 0 ? (
          <div className="card meta-profile-empty">
            <h2>لا يوجد ملف Meta متصل</h2>
            <p>
              اربطي ملف Kaan أولاً ليتم عرض جميع الصفحات وحسابات إنستغرام التي
              تديرينها.
            </p>
          </div>
        ) : (
          profiles.map((profile) => (
            <article className="card meta-profile" key={profile.id}>
              <div className="card-title">
                <div>
                  <h2>{profile.displayName}</h2>
                  <p>
                    {profile.accounts.length} حساب متاح للتعيين ·{" "}
                    {profile.lastSyncedAt
                      ? `آخر تحديث ${new Date(profile.lastSyncedAt).toLocaleString()}`
                      : "تم الربط"}
                  </p>
                </div>
                <span className="connected">
                  <CheckCircle2 size={12} />
                  ملف متصل
                </span>
              </div>
              <div className="profile-accounts">
                {profile.accounts.map((account) => (
                  <span className="profile-account" key={account.id}>
                    {account.platform === "INSTAGRAM" ? (
                      <Instagram size={15} />
                    ) : (
                      <Facebook size={15} />
                    )}
                    {account.displayName}
                    {account.assignments.length > 0 && <small>مُعيّن</small>}
                  </span>
                ))}
              </div>
            </article>
          ))
        )}
      </section>
      <h2 className="assignment-title">تعيين الحسابات للعملاء</h2>
      <div className="accounts-grid">
        {clients.map((client) => (
          <article className="card account-client" key={client.id}>
            <div className="card-title">
              <div>
                <h2>{client.name}</h2>
                <p>إنستغرام مطلوب · فيسبوك اختياري</p>
              </div>
            </div>
            <span className={`sync-health ${syncHealth(client).state}`}>
              {syncHealth(client).label}
            </span>
            <DataHealth
              connection={client.connections?.find(
                (item) => item.platform === "INSTAGRAM",
              )}
            />
            {(["INSTAGRAM", "FACEBOOK"] as const).map((platform) => (
              <label className="account-assignment" key={platform}>
                <span
                  className={`platform ${platform === "INSTAGRAM" ? "instagram" : "future"}`}
                >
                  {platform === "INSTAGRAM" ? (
                    <Instagram size={18} />
                  ) : (
                    <Facebook size={18} />
                  )}
                </span>
                <span>
                  {platform === "INSTAGRAM" ? "إنستغرام" : "فيسبوك (اختياري)"}
                </span>
                <select
                  value={selected(client, platform)}
                  disabled={saving === client.id}
                  onChange={(event) =>
                    void assign(client, platform, event.target.value)
                  }
                >
                  <option value="">
                    {platform === "INSTAGRAM"
                      ? "اختاري حساب إنستغرام"
                      : "لا ندير فيسبوك لهذا العميل"}
                  </option>
                  {accounts
                    .filter((account) => account.platform === platform)
                    .map((account) => (
                      <option
                        key={account.id}
                        value={account.id}
                        disabled={account.assignments.some(
                          (assignment) => assignment.clientId !== client.id,
                        )}
                      >
                        {account.displayName} — {account.profileName}
                      </option>
                    ))}
                </select>
              </label>
            ))}
            <button
              className="btn primary full-width"
              disabled={syncing === client.id || !selected(client, "INSTAGRAM")}
              onClick={() => void sync(client.id)}
            >
              <RefreshCw size={15} />
              {syncing === client.id ? "جارٍ التحديث..." : t.refresh}
            </button>
            {canRunBackfill ? (
              <button
                className="btn quiet full-width"
                disabled={
                  backfilling === client.id ||
                  !selected(client, "INSTAGRAM") ||
                  backfillStatus(client) === "COMPLETED" ||
                  backfillStatus(client) === "RUNNING" ||
                  backfillStatus(client) === "PARTIAL"
                }
                onClick={() => void backfill(client.id)}
              >
                <History size={15} />
                {backfilling === client.id
                  ? "جارٍ التحميل التاريخي..."
                  : "تحميل البيانات التاريخية"}
              </button>
            ) : (
              selected(client, "INSTAGRAM") &&
              (!backfillStatus(client) ||
                backfillStatus(client) === "NOT_STARTED") && (
                <small className="account-empty">
                  بحاجة إلى مدير لتشغيل التحميل التاريخي الأولي لهذا الحساب.
                </small>
              )
            )}
            {syncResults[client.id] && (
              <div className="sync-result">
                <b>
                  {syncResults[client.id].joinedExisting
                    ? "تم الانضمام إلى تحديث جارٍ"
                    : `تم تحديث ${syncResults[client.id].posts} منشور`}
                </b>
                {syncResults[client.id].results.map((result) => (
                  <small className={result.status} key={result.connectionId}>
                    {result.displayName}:{" "}
                    {result.status === "success"
                      ? `${result.posts} منشور · ${(result.durationMs / 1000).toFixed(1)} ث`
                      : result.error}
                  </small>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

type SettingsUser = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  createdAt: string;
};

function SettingsPage({
  t,
  user,
  onSignOut,
  setToast,
}: {
  t: Dictionary;
  user: WorkspaceUser;
  onSignOut: () => Promise<void>;
  setToast: (value: string) => void;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const canManageUsers = hasFeature(user, "manage_users");
  const [tab, setTab] = useState<"account" | "users" | "integrations">(
    "account",
  );
  const tabs = [
    { id: "account" as const, label: arabic ? "الحساب" : "Account" },
    ...(canManageUsers
      ? [
          {
            id: "users" as const,
            label: arabic ? "المستخدمون والأدوار" : "Users & roles",
          },
        ]
      : []),
    {
      id: "integrations" as const,
      label: arabic ? "التكاملات" : "Integrations",
    },
  ];
  return (
    <section className="settings-page">
      <section className="hero">
        <div>
          <h1>{t.settings}</h1>
          <p>
            {arabic
              ? "إدارة حسابك، فريق العمل، والتكاملات المتصلة بالمنصة."
              : "Manage your account, team access, and connected integrations."}
          </p>
        </div>
      </section>
      <div className="settings-tabs">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={`settings-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "account" && (
        <AccountSettings t={t} user={user} onSignOut={onSignOut} />
      )}
      {tab === "users" && canManageUsers && (
        <UsersSettings t={t} setToast={setToast} />
      )}
      {tab === "integrations" && <IntegrationsSettings t={t} user={user} />}
    </section>
  );
}

function AccountSettings({
  t,
  user,
  onSignOut,
}: {
  t: Dictionary;
  user: WorkspaceUser;
  onSignOut: () => Promise<void>;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const roleLabel: Record<string, string> = {
    ADMIN: arabic ? "مدير" : "Admin",
    EDITOR: arabic ? "محرر" : "Editor",
    VIEWER: arabic ? "مشاهد" : "Viewer",
  };
  const [signingOut, setSigningOut] = useState(false);
  return (
    <section className="card settings-card">
      <div className="card-title">
        <div>
          <h2>{arabic ? "معلومات الحساب" : "Account details"}</h2>
          <p>
            {arabic
              ? "بيانات تسجيل الدخول الحالية."
              : "Your current sign-in details."}
          </p>
        </div>
      </div>
      <div className="settings-field">
        <span>{arabic ? "الاسم" : "Name"}</span>
        <b>{user.name ?? "—"}</b>
      </div>
      <div className="settings-field">
        <span>{arabic ? "البريد الإلكتروني" : "Email"}</span>
        <b>{user.email}</b>
      </div>
      <div className="settings-field">
        <span>{arabic ? "الدور" : "Role"}</span>
        <b>{roleLabel[user.role] ?? user.role}</b>
      </div>
      <button
        className="btn quiet danger-button"
        disabled={signingOut}
        onClick={async () => {
          setSigningOut(true);
          await onSignOut();
        }}
      >
        <LogOut size={16} />
        {signingOut
          ? arabic
            ? "جارٍ تسجيل الخروج..."
            : "Signing out..."
          : arabic
            ? "تسجيل الخروج"
            : "Sign out"}
      </button>
    </section>
  );
}

function UsersSettings({
  t,
  setToast,
}: {
  t: Dictionary;
  setToast: (value: string) => void;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const [users, setUsers] = useState<SettingsUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "EDITOR" | "VIEWER">("EDITOR");
  const [submitting, setSubmitting] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState("");
  const roleLabel: Record<string, string> = {
    ADMIN: arabic ? "مدير" : "Admin",
    EDITOR: arabic ? "محرر" : "Editor",
    VIEWER: arabic ? "مشاهد" : "Viewer",
  };
  const loadUsers = () => {
    setLoading(true);
    return fetch("/api/users")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { users?: SettingsUser[] } | null) =>
        setUsers(data?.users ?? []),
      )
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void loadUsers();
  }, []);
  const addUser = async () => {
    if (!name.trim() || !email.trim() || password.length < 8) {
      setError(
        arabic
          ? "أدخلي الاسم والبريد وكلمة مرور لا تقل عن 8 أحرف."
          : "Enter name, email, and a password of at least 8 characters.",
      );
      return;
    }
    setSubmitting(true);
    setError("");
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        email: email.trim(),
        password,
        role,
      }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok)
      setError(
        data.error ??
          (arabic ? "تعذر إنشاء المستخدم." : "Unable to create the user."),
      );
    else {
      setName("");
      setEmail("");
      setPassword("");
      setRole("EDITOR");
      setToast(arabic ? "تم إنشاء المستخدم." : "User created.");
      await loadUsers();
    }
    setSubmitting(false);
  };
  const changeRole = async (id: string, nextRole: string) => {
    setUpdating(id);
    setError("");
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, role: nextRole }),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok)
      setError(
        data.error ??
          (arabic ? "تعذر تحديث الدور." : "Unable to update the role."),
      );
    else await loadUsers();
    setUpdating(null);
  };
  return (
    <section className="settings-users">
      <section className="card settings-card">
        <div className="card-title">
          <div>
            <h2>{arabic ? "دعوة مستخدم جديد" : "Invite a new user"}</h2>
            <p>
              {arabic
                ? "أنشئي حساباً جديداً وحدّدي دوره."
                : "Create a new account and set its role."}
            </p>
          </div>
        </div>
        <div className="settings-invite-form">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={arabic ? "الاسم" : "Name"}
          />
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={arabic ? "البريد الإلكتروني" : "Email"}
            type="email"
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={arabic ? "كلمة المرور" : "Password"}
            type="password"
          />
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
          >
            <option value="ADMIN">{roleLabel.ADMIN}</option>
            <option value="EDITOR">{roleLabel.EDITOR}</option>
            <option value="VIEWER">{roleLabel.VIEWER}</option>
          </select>
          <button
            className="btn primary"
            disabled={submitting}
            onClick={() => void addUser()}
          >
            <UserPlus size={16} />
            {submitting
              ? arabic
                ? "جارٍ الإنشاء..."
                : "Creating..."
              : arabic
                ? "إنشاء"
                : "Create"}
          </button>
        </div>
        {error && <small className="client-error">{error}</small>}
      </section>
      <section className="card settings-card">
        <div className="card-title">
          <div>
            <h2>{arabic ? "المستخدمون" : "Users"}</h2>
            <p>
              {arabic
                ? "غيّري دور أي مستخدم في أي وقت."
                : "Change any user's role at any time."}
            </p>
          </div>
        </div>
        {loading ? (
          <p>{arabic ? "جارٍ تحميل المستخدمين..." : "Loading users..."}</p>
        ) : (
          <div className="settings-user-list">
            {users.map((item) => (
              <div className="settings-user-row" key={item.id}>
                <div>
                  <b>{item.name ?? item.email}</b>
                  <small>{item.email}</small>
                </div>
                <select
                  value={item.role}
                  disabled={updating === item.id}
                  onChange={(event) =>
                    void changeRole(item.id, event.target.value)
                  }
                >
                  <option value="ADMIN">{roleLabel.ADMIN}</option>
                  <option value="EDITOR">{roleLabel.EDITOR}</option>
                  <option value="VIEWER">{roleLabel.VIEWER}</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function IntegrationsSettings({
  t,
  user,
}: {
  t: Dictionary;
  user: WorkspaceUser;
}) {
  const arabic = t.dashboard === "الرئيسية";
  const [profiles, setProfiles] = useState<MetaProfile[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch("/api/meta-accounts")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { profiles?: MetaProfile[] } | null) =>
        setProfiles(data?.profiles ?? []),
      )
      .finally(() => setLoading(false));
  }, []);
  const accountsCount = profiles.reduce(
    (sum, profile) => sum + profile.accounts.length,
    0,
  );
  return (
    <section className="settings-users">
      <section className="card settings-card">
        <div className="card-title">
          <div>
            <h2>
              <ShieldCheck size={16} /> Google
            </h2>
            <p>
              {arabic
                ? "مطلوب لتصدير التقارير إلى Google Slides."
                : "Required to export reports to Google Slides."}
            </p>
          </div>
        </div>
        <div className="settings-field">
          <span>{arabic ? "الحالة" : "Status"}</span>
          <b className={user.googleConnected ? "success" : ""}>
            {user.googleConnected
              ? arabic
                ? "متصل"
                : "Connected"
              : arabic
                ? "غير متصل"
                : "Not connected"}
          </b>
        </div>
        <a className="btn quiet compact" href="/api/connectors/google">
          <Link2 size={14} />
          {user.googleConnected
            ? arabic
              ? "إعادة الربط"
              : "Reconnect"
            : arabic
              ? "ربط Google"
              : "Connect Google"}
        </a>
      </section>
      <section className="card settings-card">
        <div className="card-title">
          <div>
            <h2>Meta</h2>
            <p>
              {arabic
                ? "مصدر بيانات إنستغرام وفيسبوك للتقارير."
                : "The Instagram and Facebook data source for reports."}
            </p>
          </div>
        </div>
        <div className="settings-field">
          <span>{arabic ? "ملفات Meta متصلة" : "Connected Meta profiles"}</span>
          <b>{loading ? "..." : profiles.length}</b>
        </div>
        <div className="settings-field">
          <span>{arabic ? "حسابات متاحة" : "Available accounts"}</span>
          <b>{loading ? "..." : accountsCount}</b>
        </div>
        <a className="btn quiet compact" href="/api/connectors/meta">
          <Link2 size={14} />
          {arabic ? "ربط ملف Meta جديد" : "Connect a new Meta profile"}
        </a>
      </section>
    </section>
  );
}

function Metric({
  label,
  value,
  change,
  Icon,
  warn = false,
}: {
  label: string;
  value: string;
  change: string;
  Icon: typeof Users;
  warn?: boolean;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        <span>{label}</span>
        <span className="metric-icon">
          <Icon size={15} />
        </span>
      </div>
      <div className="metric-value">{value}</div>
      <div className={`metric-change ${warn ? "down" : ""}`}>{change}</div>
    </div>
  );
}
function Connection({
  name,
  handle,
  Icon,
  connected,
  label,
  onClick,
}: {
  name: string;
  handle: string;
  Icon: typeof Instagram;
  connected?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <div className="connection">
      <span className={`platform ${connected ? "instagram" : "future"}`}>
        <Icon size={18} />
      </span>
      <div className="connection-main">
        <b>{name}</b>
        <span>{handle}</span>
      </div>
      <button
        className={connected ? "connected" : "btn quiet compact"}
        onClick={onClick}
      >
        {label}
      </button>
    </div>
  );
}
function ClientConnectionsRow({
  clientName,
  items,
  label,
  disconnectedLabel,
  onClick,
}: {
  clientName: string;
  items: Array<{
    id: string;
    platform: string;
    displayName: string;
    lastSuccessfulSyncAt: string | null;
  }>;
  label: string;
  disconnectedLabel: string;
  onClick?: () => void;
}) {
  const allConnected = items.every((item) =>
    Boolean(item.lastSuccessfulSyncAt),
  );
  return (
    <div className="connection">
      <span className="platform-group">
        {items.map((item) => (
          <span
            key={item.id}
            className={`platform ${item.lastSuccessfulSyncAt ? "instagram" : "future"}`}
          >
            {item.platform === "INSTAGRAM" ? (
              <Instagram size={15} />
            ) : (
              <Facebook size={15} />
            )}
          </span>
        ))}
      </span>
      <div className="connection-main">
        <b>{clientName}</b>
        <span>{items.map((item) => item.displayName).join(" · ")}</span>
      </div>
      <button
        className={allConnected ? "connected" : "btn quiet compact"}
        onClick={onClick}
      >
        {allConnected ? label : disconnectedLabel}
      </button>
    </div>
  );
}
function Report({
  title,
  subtitle,
  status,
  onOpen,
  open,
}: {
  title: string;
  subtitle: string;
  status: string;
  onOpen: () => void;
  open: string;
}) {
  return (
    <div className="report">
      <span className="report-icon">
        <FileText size={18} />
      </span>
      <div>
        <b>{title}</b>
        <small>{subtitle}</small>
      </div>
      <span className="status">{status}</span>
      <button className="btn quiet compact" onClick={onOpen}>
        {open}
      </button>
    </div>
  );
}
