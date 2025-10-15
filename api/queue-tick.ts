import type { VercelRequest, VercelResponse } from "@vercel/node";
import "dotenv/config";
import { queue } from "../server/lib/queue.js";
import { processIngestionJob } from "../server/workers/ingestion.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!["GET", "POST"].includes(req.method || "")) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, message: "Method Not Allowed" });
  }

  const secret = process.env.QUEUE_TICK_SECRET;
  if (secret) {
    const provided = (req.headers["x-queue-secret"] || req.query.secret) as string | undefined;
    if (provided !== secret) return res.status(401).json({ ok: false, message: "Unauthorized" });
  }

  const job = await queue.dequeue();
  if (!job) return res.status(204).end();

  try {
    await processIngestionJob(job);
    return res.status(200).json({ ok: true, jobId: job.id, mode: job.mode });
  } catch (err: any) {
    try {
      await queue.markFailed(job.id, err?.message || String(err), (job.attempt || 0) < 3);
    } catch {}
    return res.status(500).json({ ok: false, jobId: job.id, error: err?.message || String(err) });
  }
}
