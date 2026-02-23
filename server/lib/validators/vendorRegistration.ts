export type VendorRegistrationInput = {
  companyName: string;
  billingEmail: string;
  phone: string | null;
  country: string | null;
  timezone: string | null;
};

type ValidationSuccess = { ok: true; data: VendorRegistrationInput };
type ValidationFailure = { ok: false; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+\d{6,15}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateVendorRegistrationInput(raw: any): ValidationSuccess | ValidationFailure {
  const companyName = String(raw?.companyName || "").trim();
  const billingEmail = String(raw?.billingEmail || "").trim().toLowerCase();
  const phoneRaw = String(raw?.phone || "").trim();
  const countryRaw = String(raw?.country || "").trim();
  const timezoneRaw = String(raw?.timezone || "").trim();

  if (companyName.length < 2 || companyName.length > 128) {
    return { ok: false, message: "companyName must be between 2 and 128 characters." };
  }

  if (!EMAIL_RE.test(billingEmail)) {
    return { ok: false, message: "billingEmail must be a valid email address." };
  }

  if (phoneRaw && !E164_RE.test(phoneRaw)) {
    return { ok: false, message: "phone must be in E.164 format, e.g. +15551234567." };
  }

  const country = countryRaw ? countryRaw.toUpperCase() : null;
  if (country && !COUNTRY_RE.test(country)) {
    return { ok: false, message: "country must be a 2-letter ISO code." };
  }

  const timezone = timezoneRaw || null;
  if (timezone && !isValidTimeZone(timezone)) {
    return { ok: false, message: "timezone must be a valid IANA timezone." };
  }

  return {
    ok: true,
    data: {
      companyName,
      billingEmail,
      phone: phoneRaw || null,
      country,
      timezone,
    },
  };
}
