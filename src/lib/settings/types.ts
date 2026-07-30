import type { Role } from "@prisma/client";
import type { ReactNode } from "react";

export type SettingCategory = "organization" | "integrations" | "users" | "dashboard" | "automations";

export type SettingsModuleConfig = {
  id: string;
  label: string;
  category: SettingCategory;
  description?: string;
  /** Role required to view the module. */
  requiredRole: Role;
  /** Whether the module can be disabled from Settings. */
  configurable: boolean;
};

export type SettingsModule = SettingsModuleConfig & {
  isEnabled(): boolean;
  getConfig(): Promise<Record<string, string>>;
  component?: ReactNode;
};

export type SettingsValue = {
  moduleId: string;
  key: string;
  value: string;
};
