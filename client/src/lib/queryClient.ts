import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getJWT, refreshJWT } from "@/lib/jwt";

/** Build URL from a React-Query key */
function urlFromKey(key: unknown): string {
  let path = "", params: Record<string, unknown> | undefined;
  if (Array.isArray(key)) {
    path = String(key[0] ?? "");
    if (typeof key[1] === "object" && key[1]) params = key[1] as any;
  } else path = String(key ?? "");

  if (!params) return path;

  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(x => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/** Fetch with cached token; if 401, refresh once. NEVER tries to mint a JWT if cooldown is active. */
export async function apiRequest(
  method: string,
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal }
): Promise<Response> {
  async function doFetch(forceFresh = false) {
    const token = forceFresh ? await refreshJWT() : await getJWT();

    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      headers["X-Appwrite-JWT"] = token;
    }

    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "include",
      signal: opts?.signal,
      cache: "no-store",
    });
  }

  const res1 = await doFetch(false);
  if (res1.status !== 401) return res1;

  // Try once with a forced refresh (skipped if cooldown is active)
  const res2 = await doFetch(true);
  return res2;
}

async function ensureOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export function getQueryFn(): QueryFunction<any> {
  return async ({ queryKey, signal }) => {
    const url = urlFromKey(queryKey);
    const res = await apiRequest("GET", url, undefined, { signal });
    await ensureOk(res);
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn(),
      refetchOnWindowFocus: false,
      retry: false,       // IMPORTANT: don’t multiply calls while in cooldown
      staleTime: 60_000,
    },
    mutations: { retry: false },
  },
});
