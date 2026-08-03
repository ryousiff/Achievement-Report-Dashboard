import { google } from "googleapis";
import { db } from "@/lib/db";
import { getGoogleAuthClient, GoogleReconnectRequiredError, hasExportScope } from "@/lib/google";

const sharedDriveId = process.env.GOOGLE_SHARED_DRIVE_ID;

const periodFolderNames: Record<string, string> = {
  monthly: "التقارير الشهرية",
  quarterly: "التقارير الربع سنوية",
  halfYearly: "التقارير نصف السنوية",
  yearly: "التقارير السنوية",
};

function getReportPeriodType(report: { periodStart: Date; periodEnd: Date }) {
  const days = Math.round((report.periodEnd.getTime() - report.periodStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  if (days <= 40) return "monthly";
  if (days <= 100) return "quarterly";
  if (days <= 200) return "halfYearly";
  return "yearly";
}

async function findOrCreateFolder(name: string, parentId: string, drive: ReturnType<typeof google.drive>) {
  const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  const existing = await drive.files.list({
    q,
    spaces: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id, name)",
  });
  const folder = existing.data.files?.[0];
  if (folder?.id) return folder.id;

  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error(`Unable to create folder: ${name}`);
  return created.data.id;
}

export async function getClientFolder(clientId: string, drive: ReturnType<typeof google.drive>) {
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error("Client not found.");
  if (client.driveFolderId) return client.driveFolderId;
  if (!sharedDriveId) throw new Error("Shared drive is not configured.");

  const q = `mimeType='application/vnd.google-apps.folder' and '${sharedDriveId}' in parents and name = '${client.name.replace(/'/g, "\\'")}' and trashed = false`;
  const existing = await drive.files.list({
    q,
    spaces: "drive",
    driveId: sharedDriveId,
    corpora: "drive",
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "files(id, name)",
  });
  const folder = existing.data.files?.[0];
  if (folder?.id) {
    await db.client.update({ where: { id: clientId }, data: { driveFolderId: folder.id } });
    return folder.id;
  }

  const created = await drive.files.create({
    requestBody: { name: client.name, mimeType: "application/vnd.google-apps.folder", parents: [sharedDriveId] },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  if (!created.data.id) throw new Error("Unable to create client folder.");
  await db.client.update({ where: { id: clientId }, data: { driveFolderId: created.data.id } });
  return created.data.id;
}

export async function getPeriodFolder(clientFolderId: string, report: { periodStart: Date; periodEnd: Date }, drive: ReturnType<typeof google.drive>) {
  const periodType = getReportPeriodType(report);
  const name = periodFolderNames[periodType] ?? periodFolderNames.monthly;
  return findOrCreateFolder(name, clientFolderId, drive);
}

export function findPlaceholder(slide: any, type: string) {
  return slide.pageElements?.find((element: any) => element.shape?.placeholder?.type === type);
}

export function buildSlideRequests(report: { title: string; periodStart: Date; periodEnd: Date; client: { name: string }; blocks: Array<{ id: string; type: string; content: unknown }> }, presentation: any) {
  const requests: any[] = [];
  const titleSlide = presentation.slides?.[0];
  if (titleSlide) {
    const titleShape = findPlaceholder(titleSlide, "TITLE");
    const subtitleShape = findPlaceholder(titleSlide, "SUBTITLE");
    if (titleShape) {
      requests.push({ insertText: { objectId: titleShape.objectId, text: report.title } });
    }
    if (subtitleShape) {
      const period = `${report.periodStart.toISOString().slice(0, 10)} — ${report.periodEnd.toISOString().slice(0, 10)}`;
      requests.push({ insertText: { objectId: subtitleShape.objectId, text: `${report.client.name} · ${period}` } });
    }
  }

  for (const block of report.blocks) {
    const content = (block.content ?? {}) as Record<string, unknown>;
    const slideId = `slide_${block.id}`;
    const titleId = `title_${block.id}`;
    const bodyId = `body_${block.id}`;
    requests.push({
      createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: "BLANK" } },
    });
    requests.push({
      createShape: {
        objectId: titleId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 620, unit: "PT" }, height: { magnitude: 60, unit: "PT" } },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 40,
            translateY: 40,
            unit: "PT",
          },
        },
      },
    });
    requests.push({ insertText: { objectId: titleId, text: typeof content.title === "string" ? content.title : "" } });
    requests.push({
      createShape: {
        objectId: bodyId,
        shapeType: "TEXT_BOX",
        elementProperties: {
          pageObjectId: slideId,
          size: { width: { magnitude: 620, unit: "PT" }, height: { magnitude: 320, unit: "PT" } },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 40,
            translateY: 120,
            unit: "PT",
          },
        },
      },
    });
    let body = typeof content.body === "string" ? content.body : "";
    if (block.type === "KPI" && Array.isArray(content.kpis)) {
      body = (content.kpis as Array<{ label?: string; value?: string }>)
        .map((kpi) => `${kpi.label ?? ""}: ${kpi.value ?? ""}`)
        .join("\n");
    }
    if (block.type === "MEDIA" && Array.isArray(content.mediaItems)) {
      body = (content.mediaItems as Array<{ caption?: string }>)
        .map((item, index) => `${index + 1}. ${item.caption ?? ""}`)
        .join("\n");
    }
    requests.push({ insertText: { objectId: bodyId, text: body } });
  }
  return requests;
}

export async function exportReportToSlides(reportId: string, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true } });
  if (!user?.googleRefreshToken) throw new Error("Connect your Google account first.");

  const auth = await getGoogleAuthClient(user.googleRefreshToken);
  // Someone who only ever completed Google *sign-in* (openid/email/profile) has a token, but it was never
  // granted Drive/Slides scope — surface that the same way as an outright missing/revoked connection.
  if (!hasExportScope(auth.credentials.scope)) throw new GoogleReconnectRequiredError("Connect Google Drive access to export reports.");
  const drive = google.drive({ version: "v3", auth });
  const slides = google.slides({ version: "v1", auth });

  const report = await db.report.findUnique({
    where: { id: reportId },
    include: { client: true, blocks: { orderBy: { position: "asc" } } },
  });
  if (!report) throw new Error("Report not found.");
  if (report.status !== "APPROVED" && report.status !== "EXPORTED") throw new Error("Only approved reports can be exported to Google Slides.");

  const clientFolderId = await getClientFolder(report.clientId, drive);
  const periodFolderId = await getPeriodFolder(clientFolderId, report, drive);

  const file = await drive.files.create({
    requestBody: {
      name: report.title,
      mimeType: "application/vnd.google-apps.presentation",
      parents: [periodFolderId],
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  if (!file.data.id) throw new Error("Unable to create Google Slides file.");

  const presentation = await slides.presentations.get({ presentationId: file.data.id });
  const requests = buildSlideRequests(report, presentation.data);
  await slides.presentations.batchUpdate({ presentationId: file.data.id, requestBody: { requests } });

  const exportRecord = await db.reportExport.create({
    data: { reportId, orientation: report.orientation, fileUrl: file.data.webViewLink ?? `https://docs.google.com/presentation/d/${file.data.id}/edit` },
  });
  await db.report.update({ where: { id: reportId }, data: { status: "EXPORTED" } });
  return { export: exportRecord, presentationId: file.data.id };
}
