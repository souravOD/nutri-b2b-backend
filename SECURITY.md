# Security Policy

- Do not commit secrets. Use `.env.example` + Vercel Project settings for real values.
- Use **pooled** DB connections on Vercel to avoid connection storms.
- Rotate keys on compromise; prefer least-privilege service keys.
- Report vulnerabilities privately to the maintainers.
