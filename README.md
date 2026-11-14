# RodAI Frontend

This repository contains the RodAI browser interface. RodAI is a local-first road perception research and demonstration platform. Its outputs are experimental, may be wrong, and must not be used as the sole basis for safety-critical or enforcement decisions.

## Development

Requires Node.js 22.13.1 and npm. Install from the committed lockfile with `npm ci`, then use `npm run dev`, `npm run lint`, `npm test`, and `npm run build`.

The interface reads actual backend state from `/api/v1/health`. Video input and inference are not implemented in this foundation build. The integrated Docker Compose environment and backend live in the `rodai-backend` repository.

## Pull requests

Open changes against `main`. GitHub Actions runs lint, tests, and the production build. The repository's default branch and required status checks must be configured in GitHub settings.
