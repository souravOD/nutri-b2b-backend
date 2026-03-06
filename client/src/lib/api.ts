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

  // Settings
  async getSettings() {
    const res = await apiRequest("GET", "/api/settings");
    if (!res.ok) throw new Error(`Settings fetch failed: ${res.status}`);
    return res.json();
  },
  async putSetting(key: string, value: unknown) {
    const res = await apiRequest("PUT", `/api/settings/${encodeURIComponent(key)}`, { value });
    if (!res.ok) throw new Error(`Settings save failed: ${res.status}`);
    return res.json();
  },

  // Role Permissions
  async getRolePermissions(vendorId?: string) {
    const params = vendorId ? { vendor_id: vendorId } : undefined;
    const res = await apiRequest("GET", `/api/role-permissions${qs(params)}`);
    if (!res.ok) throw new Error(`Role permissions fetch failed: ${res.status}`);
    return res.json();
  },
  async putRolePermissions(role: string, permissions: string[]) {
    const res = await apiRequest("PUT", "/api/role-permissions", { role, permissions });
    if (!res.ok) throw new Error(`Role permissions save failed: ${res.status}`);
    return res.json();
  },
};
