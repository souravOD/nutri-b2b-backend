/**
 * Returns a safe error detail for API responses.
 * In production: logs full error server-side and returns generic message.
 * In development: returns the actual error message for debugging.
 */
export function safeErrorDetail(err: unknown, fallback: string): string {
  if (process.env.NODE_ENV === "production") {
    console.error("[500]", fallback, err);
    return "Internal server error";
  }
  return (err instanceof Error ? err.message : String(err ?? fallback)) || fallback;
}
