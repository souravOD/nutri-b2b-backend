# B2B Unified Schema Appwrite Hardening Runbook

## Scope
This runbook hardens Appwrite data/collections so B2B runtime uses:
- Appwrite: auth, teams, `vendors`, `user_profiles`
- Supabase (`gold.*`): business data and access links

## Required Appwrite Collections
- Keep: `vendors`, `user_profiles`
- Deprecate from runtime (read-only/archive): `products`, `customers`, `ingestion_jobs`, `vendor_mappings`, `vendor_sources`

## Vendors Collection Contract
Required attributes:
- `slug` (string, lowercase, unique)
- `team_id` (string, unique)
- `status` (enum-like string: `active|inactive|suspended`)
- `domains` (string[]; lowercase)

Recommended attributes:
- `billing_email` (string)
- `owner_user_id` (string)

## User Profiles Collection Contract
Required attributes:
- `user_id` (string, unique)
- `vendor_id` (string; interpreted as vendor slug)
- `role` (string; mapped to vendor roles)

Recommended attributes:
- `vendor_slug` (string, same as `vendor_id`)
- `team_id` (string, for direct team fallback)

## Required Indexes
`vendors`:
- unique `slug`
- unique `team_id`

`user_profiles`:
- unique `user_id`
- non-unique `vendor_id`

## Data Cleanup Steps
1. Normalize `vendors.slug` to lowercase.
2. Normalize `vendors.domains`:
   - lowercase
   - trim
   - remove blanks
   - de-duplicate
3. Normalize `vendors.status` to `active|inactive|suspended`.
4. Null invalid placeholders in `billing_email` and `owner_user_id`.
5. Validate each active vendor has:
   - valid `team_id`
   - at least one valid domain
6. Validate each active `user_profiles` document resolves to exactly one vendor slug.

## Runtime Flow Validation
1. Register/verify user in Appwrite.
2. Ensure user is in vendor team.
3. Ensure `user_profiles.user_id` exists with correct `vendor_id` slug.
4. Call backend `POST /onboard/self` with Appwrite JWT.
5. Verify Supabase rows:
   - `gold.b2b_users`
   - `gold.b2b_user_links`

## Rollback Notes
- Appwrite collection/index updates are forward-compatible.
- If runtime issues occur, keep Appwrite auth path active and disable onboarding sync retries on client.
- Do not re-enable Appwrite business-data collections as source-of-truth.