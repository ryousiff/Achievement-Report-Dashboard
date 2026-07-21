export function requiredText(value: unknown, field: string, maxLength = 160) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) throw new Error(`${field} is required and must be ${maxLength} characters or fewer.`);
  return value.trim();
}

export function dateValue(value: unknown, field: string) {
  const date = new Date(typeof value === "string" ? value : "");
  if (Number.isNaN(date.valueOf())) throw new Error(`${field} must be a valid ISO date.`);
  return date;
}

export function enumValue<T extends string>(value: unknown, valid: readonly T[], field: string): T {
  if (typeof value !== "string" || !valid.includes(value as T)) throw new Error(`${field} is invalid.`);
  return value as T;
}
