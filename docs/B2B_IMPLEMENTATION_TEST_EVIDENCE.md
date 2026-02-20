# B2B Unified Schema Implementation Test Evidence

## Executed Checks

### Backend
Command:
```bash
npm run check
```
Result: PASS

Command:
```bash
npm test
```
Result: FAIL (pre-existing Jest/ESM config issue unrelated to this change set)

Failure summary:
- `server/vite.ts` uses `import.meta` which is not supported by current Jest TS module setting.
- Test suite did not execute business tests due compilation-stage failure.

### Frontend
Command:
```bash
pnpm build
```
Result: PASS

Command:
```bash
pnpm lint
```
Result: BLOCKED (Next.js interactive ESLint initialization prompt; no non-interactive config in repo)

Command:
```bash
pnpm exec tsc --noEmit
```
Result: FAIL (pre-existing type issues outside this change set, notably in `app/customers/[id]/page.tsx`, `components/customers/CustomerCard.tsx`, and `app/products/page.tsx`)

## Functional Verification Covered by Code Changes
- Onboarding endpoint now enforces strict vendor resolution order: `team_id -> slug -> domain`.
- Unknown vendor path returns deterministic `409 vendor_not_provisioned`.
- Mapping mismatch path returns deterministic `409 vendor_team_mismatch`.
- Invalid JWT path returns deterministic `401 invalid_token`.
- Queue/worker raw SQL now schema-qualified:
  - `public.ingestion_jobs`
  - `public.stg_products`
  - `public.stg_customers`
  - `gold.products`
  - `gold.b2b_customers`
- Frontend sync path centralized via `components/auth-guard.tsx` + `lib/sync.ts`.
- Jobs UI API calls now use backend client instead of relative direct fetch.
- Customer create form contracts aligned to `onClose/onCreated`.

## Pending Manual UAT (Not Run Here)
1. Register + verify user with pre-provisioned vendor domain.
2. Confirm `POST /onboard/self` creates/updates:
   - `gold.b2b_users`
   - `gold.b2b_user_links`
3. Confirm onboarding rejects unknown vendor with `vendor_not_provisioned`.
4. Confirm mismatch returns `vendor_team_mismatch`.
5. Run products/customers ingestion and confirm write paths:
   - stage in `public.*`
   - final write in `gold.*`.