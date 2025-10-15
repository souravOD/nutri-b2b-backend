import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY environment variables are required");
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[env] Missing ${name}. Put it in your .env`);
  return v;
}

const SUPABASE_URL = required("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = required("SUPABASE_SERVICE_ROLE_KEY"); // service-role key (server only)

export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { "X-Client-Info": "nutriapp-b2b-backend" } },
});

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export async function ensureBucket(name: string) {
  const { data } = await supabaseAdmin.storage.getBucket(name);
  if (!data) {
    await supabaseAdmin.storage.createBucket(name, {
      public: true,
      fileSizeLimit: '104857600', // 100MB
      allowedMimeTypes: ['text/csv', 'application/vnd.ms-excel', 'application/octet-stream'],
    });
  }
}

// TUS resumable upload helper
export async function createResumableUpload(
  bucket: string,
  filePath: string,
  maxFileSize = 10 * 1024 * 1024 * 1024 // 10GB
) {
  const { data, error } = await supabaseAdmin.storage
    .from(bucket)
    .createSignedUploadUrl(filePath, {
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to create resumable upload: ${error.message}`);
  }

  return data;
}

// Vault operations for secure secrets storage
export async function storeSecret(name: string, secret: string, description?: string) {
  const { data, error } = await supabaseAdmin
    .from('vault.secrets')
    .insert({
      name,
      secret,
      description
    });

  if (error) {
    throw new Error(`Failed to store secret: ${error.message}`);
  }

  return data;
}

export async function getSecret(secretRef: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('vault.decrypted_secrets')
    .select('decrypted_secret')
    .eq('id', secretRef)
    .single();

  if (error) {
    throw new Error(`Failed to retrieve secret: ${error.message}`);
  }

  return data.decrypted_secret;
}
