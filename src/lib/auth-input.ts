import { requiredText } from "@/lib/validators";

export function emailValue(value: unknown) {
  const email = requiredText(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("email must be valid.");
  return email;
}

export function passwordValue(value: unknown) {
  const password = requiredText(value, "password", 256);
  if (password.length < 12) throw new Error("password must be at least 12 characters.");
  return password;
}
