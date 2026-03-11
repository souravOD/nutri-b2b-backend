/**
 * Centralized mappers for gold schema status/activity values.
 * Used by routes.ts and storage.ts to ensure consistent mapping.
 */

export function toGoldProductStatus(status?: string | null): "active" | "discontinued" | "out_of_stock" {
  const s = String(status || "active").toLowerCase();
  if (s === "inactive" || s === "discontinued") return "discontinued";
  if (s === "out_of_stock") return "out_of_stock";
  return "active";
}

export function toGoldCustomerStatus(status?: string | null): "active" | "inactive" | "suspended" {
  const s = String(status || "active").toLowerCase();
  if (s === "archived") return "inactive";
  if (s === "inactive") return "inactive";
  if (s === "suspended") return "suspended";
  return "active";
}

export function toGoldActivityLevel(activity?: string | null): "sedentary" | "lightly_active" | "moderately_active" | "very_active" | "extra_active" {
  const a = String(activity || "sedentary").toLowerCase();
  if (a === "light" || a === "lightly_active") return "lightly_active";
  if (a === "moderate" || a === "moderately_active") return "moderately_active";
  if (a === "very" || a === "very_active") return "very_active";
  if (a === "extra" || a === "extra_active") return "extra_active";
  return "sedentary";
}
