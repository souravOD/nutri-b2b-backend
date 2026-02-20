const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "dashboard",
  "login",
  "logout",
  "onboarding",
  "products",
  "customers",
  "jobs",
  "alerts",
  "search",
  "settings",
  "profile",
  "tenant",
  "vendors",
  "register",
  "verify",
]);

export function slugifyVendorName(input: string): string {
  const base = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

  return base || "vendor";
}

export function withSlugSuffix(baseSlug: string, attempt: number): string {
  if (attempt <= 1) return baseSlug;
  const suffix = `-${attempt}`;
  const maxBaseLen = Math.max(1, 32 - suffix.length);
  const trimmedBase = baseSlug.slice(0, maxBaseLen).replace(/-+$/g, "") || "vendor";
  return `${trimmedBase}${suffix}`;
}

export function isReservedVendorSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(String(slug || "").toLowerCase());
}

export function deriveDomainFromEmail(email: string): string | null {
  const normalized = String(email || "").trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at < 0) return null;
  const domain = normalized.slice(at + 1).trim();
  return domain || null;
}
