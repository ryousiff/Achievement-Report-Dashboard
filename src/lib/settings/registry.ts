import { Role } from "@prisma/client";
import { db } from "@/lib/db";
import type { SettingsModule, SettingsModuleConfig } from "./types";

const baseModules: SettingsModuleConfig[] = [
  { id: "organization", label: "Organization", category: "organization", requiredRole: Role.ADMIN, configurable: true },
  { id: "integrations", label: "Integrations", category: "integrations", requiredRole: Role.ADMIN, configurable: false },
  { id: "users", label: "Users & Roles", category: "users", requiredRole: Role.ADMIN, configurable: false },
  { id: "dashboard", label: "Dashboard", category: "dashboard", requiredRole: Role.ADMIN, configurable: true },
  { id: "automations", label: "Automations", category: "automations", requiredRole: Role.ADMIN, configurable: true },
];

export async function getModuleValues(moduleId: string): Promise<Record<string, string>> {
  const settings = await db.setting.findMany({ where: { moduleId } });
  return Object.fromEntries(settings.map((s) => [s.key, s.value]));
}

export async function getSettingsModules(): Promise<SettingsModule[]> {
  const disabled = (await getModuleValues("core"))["disabledModules"] ?? "";
  const disabledSet = new Set(disabled.split(",").filter(Boolean));
  const modules: SettingsModule[] = [];
  for (const config of baseModules) {
    modules.push({
      ...config,
      isEnabled() {
        return !disabledSet.has(config.id);
      },
      async getConfig() {
        return getModuleValues(config.id);
      },
    });
  }
  return modules;
}

export async function getVisibleModules(role: Role): Promise<SettingsModule[]> {
  const modules = await getSettingsModules();
  return modules.filter((m) => m.isEnabled() && (role === Role.ADMIN || m.requiredRole === role));
}

export async function setModuleValue(moduleId: string, key: string, value: string) {
  await db.setting.upsert({ where: { moduleId_key: { moduleId, key } }, create: { moduleId, key, value }, update: { value } });
}
