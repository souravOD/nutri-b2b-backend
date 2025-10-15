export function toItems<T = unknown>(payload: any): T[] {
    return Array.isArray(payload) ? payload : (payload?.data ?? []);
  }
  export function toTotal(payload: any): number {
    if (Array.isArray(payload)) return payload.length;
    if (typeof payload?.total === "number") return payload.total;
    const arr = payload?.data;
    return Array.isArray(arr) ? arr.length : 0;
  }
  