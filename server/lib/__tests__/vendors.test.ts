/// <reference types="jest" />

import { deriveDomainFromEmail, slugifyVendorName, withSlugSuffix } from "../vendors.js";

describe("vendors helpers", () => {
  it("slugifies company names", () => {
    expect(slugifyVendorName("Odyssey Tech Systems")).toBe("odyssey-tech-systems");
    expect(slugifyVendorName("  A  ")).toBe("a");
  });

  it("applies suffixes within slug length", () => {
    const base = "abcdefghijklmnopqrstuvwxyz123456";
    const suffixed = withSlugSuffix(base, 12);
    expect(suffixed.endsWith("-12")).toBe(true);
    expect(suffixed.length).toBeLessThanOrEqual(32);
  });

  it("derives email domain", () => {
    expect(deriveDomainFromEmail("Billing@OdysseyTS.com")).toBe("odysseyts.com");
    expect(deriveDomainFromEmail("bad-email")).toBeNull();
  });
});
