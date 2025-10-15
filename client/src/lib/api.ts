import { apiRequest } from "./queryClient";

/** Build a ?query=string safely (supports arrays). */
function qs(params?: Record<string, unknown>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.set(k, String(v));
    }
  }
  const str = sp.toString();
  return str ? `?${str}` : "";
}

/** Public API used by pages/components that call directly (optional). */
export const api = {
  // Vendors
  async getVendors(params?: any) {
    const res = await apiRequest("GET", `/vendors${qs(params)}`);
    return res.json();
  },
  async createVendor(vendor: any) {
    const res = await apiRequest("POST", "/vendors", vendor);
    return res.json();
  },

  // Customers
  async getCustomers(params?: any) {
    const res = await apiRequest("GET", `/customers${qs(params)}`);
    return res.json();
  },

  // Products
  async getProducts(params?: any) {
    const res = await apiRequest("GET", `/products${qs(params)}`);
    return res.json();
  },
  async getProduct(id: string) {
    const res = await apiRequest("GET", `/products/${encodeURIComponent(id)}`);
    return res.json();
  },

  // Jobs (ingestion)
  async getJobs(params?: any) {
    const res = await apiRequest("GET", `/jobs${qs(params)}`);
    return res.json();
  },

  // Metrics
  async getMetrics() {
    const res = await apiRequest("GET", "/metrics");
    return res.json();
  },
};
