/// <reference types="jest" />

import { validateVendorRegistrationInput } from "../validators/vendorRegistration.js";

describe("validateVendorRegistrationInput", () => {
  it("accepts valid payload", () => {
    const out = validateVendorRegistrationInput({
      companyName: "Odyssey Tech",
      billingEmail: "billing@odysseyts.com",
      phone: "+15551234567",
      country: "us",
      timezone: "America/New_York",
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.country).toBe("US");
      expect(out.data.billingEmail).toBe("billing@odysseyts.com");
    }
  });

  it("rejects bad email", () => {
    const out = validateVendorRegistrationInput({
      companyName: "Odyssey Tech",
      billingEmail: "bad-email",
    });
    expect(out.ok).toBe(false);
  });

  it("rejects bad country", () => {
    const out = validateVendorRegistrationInput({
      companyName: "Odyssey Tech",
      billingEmail: "billing@odysseyts.com",
      country: "IND",
    });
    expect(out.ok).toBe(false);
  });
});
