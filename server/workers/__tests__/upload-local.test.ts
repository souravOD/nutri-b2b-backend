/// <reference types="jest" />

import path from "path";
import request from "supertest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import app from "../../index"; // exported app

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BUCKET = process.env.SUPABASE_CSV_BUCKET || "ingestion";
const VENDOR_ID = "a3461223-51f9-4ddf-afa7-200008191820";
const SOURCE_CSV =
  process.env.SOURCE_CSV ||
  path.resolve(__dirname, "../../fixtures/products_sample.csv");

let supabaseAdmin: SupabaseClient;

async function ensureBucket(name: string) {
  const admin = supabaseAdmin as any;
  const { data, error } = await admin.storage.listBuckets?.();
  if (error) throw error;
  if (!data.some((b: any) => b.name === name)) {
    const { error: e2 } = await admin.storage.createBucket(name, { public: false });
    if (e2) throw e2;
  }
}

// jest.mock("../middleware/auth", () => ({
//     requireAuth: () => (req: any, _res: any, next: any) => {
//       req.user = { id: "test-user" };
//       req.vendorId = "a3461223-51f9-4ddf-afa7-200008191820";
//       next();
//     },
//   }));

describe("E2E: /jobs + /jobs/:id/upload + worker (Supabase real upload)", () => {
  beforeAll(async () => {
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    await ensureBucket(BUCKET);
  });

  it("ingests products CSV end-to-end", async () => {
    // 1) Create job
    const createRes = await request(app)
      .post("/jobs")
      .query({ mode: "products" })
      // If your auth middleware needs a vendor/user, pass a testing header it understands,
      // or jest.mock your auth middleware in this test file to no-op.
      .set("X-Test-Vendor-Id", VENDOR_ID)
      .expect(200);

    const { jobId, bucket, path: storagePath } = createRes.body;
    expect(jobId).toBeTruthy();
    expect(bucket).toBe(BUCKET);
    expect(storagePath).toContain(`/vendors/${VENDOR_ID}/`);

    // 2) Upload CSV (multipart)
    const uploadRes = await request(app)
      .post(`/jobs/${jobId}/upload`)
      .set("X-Test-Vendor-Id", VENDOR_ID)
      .attach("file", SOURCE_CSV) // field name must be "file"
      .expect(200);

    expect(uploadRes.body?.jobId || uploadRes.body?.ok).toBeTruthy();

    // 3) Optional: start (your backend can no-op and just re-queue)
    await request(app)
      .post(`/jobs/${jobId}/start`)
      .set("X-Test-Vendor-Id", VENDOR_ID)
      .expect(200);

    // 4) Poll until completed
    let status = "";
    let processed = 0;
    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      const r = await request(app).get(`/jobs/${jobId}`).expect(200);

      status = r.body?.status || r.body?.data?.status;
      processed = r.body?.processed || r.body?.data?.processed || 0;

      if (status === "failed") {
        throw new Error(`Job failed: ${JSON.stringify(r.body)}`);
      }
      if (status === "completed") break;

      await new Promise((res) => setTimeout(res, 1000));
    }

    expect(status).toBe("completed");
    expect(processed).toBeGreaterThan(0);

    // 5) Verify the file truly exists in Supabase Storage
    const dl = await supabaseAdmin.storage.from(bucket).download(storagePath);
    if (dl.error) throw dl.error;
    const text = await dl.data.text();
    expect(text.length).toBeGreaterThan(0);
  });
});
