# Contributing

## Branching
- Base branch: `Backend`
- Feature branches: `feat/<short-name>`, fixes: `fix/<short-name>`, chores: `chore/<short-name>`

## Commit style
Use clear, imperative subject lines:
- `feat: add ingestion cron endpoint`
- `fix: correct CORS handling`
- `chore: update README for Vercel`

## Pull Requests
1. Ensure `.env.example` is updated if new vars were added.
2. Update `README.md` if behavior or setup changed.
3. Include test steps in the PR description.
4. CI/Preview: Vercel will create a Preview deployment for your branch/PR.

## Code style
- TypeScript/Node 20 target.
- Prefer async/await.
- Log sparingly; avoid leaking secrets.
- Keep routes thin; push logic into `server/lib` or `server/workers` modules.
