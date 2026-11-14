# RodAI Frontend

This repository contains the RodAI browser interface. RodAI is a local-first road perception research and demonstration platform. Its outputs are experimental, may be wrong, and must not be used as the sole basis for safety-critical or enforcement decisions.

## Development

Requires Node.js 22.13.1 and npm. Install from the committed lockfile with `npm ci`, then use `npm run dev`, `npm run lint`, `npm test`, and `npm run build`. `npm start` serves the production build on `PORT` and is the Railway start command.

The interface reads backend state from `/api/v1/health`. Local Vite development proxies API requests to `http://127.0.0.1:8000` by default; set `VITE_API_PROXY_TARGET` to override it. A split deployment sets `VITE_API_BASE_URL` to the public backend API origin at build time. The backend CORS allowlist must include the frontend's public origin. The integrated Docker Compose environment and backend live in the `rodai-backend` repository.

## Railway frontend service

Connect this repository's `main` branch as a separate Railway service. Railpack can build the Vite project with `npm run build`; use `npm start` to serve `dist/` on Railway's `PORT`. Import `.env.railway.example` and replace the API URL with the backend service's public origin. Since Vite embeds this value into built assets, redeploy with a fresh build after changing it. The frontend is public and must never contain backend secrets.

## Pull requests

Open changes against `main`. GitHub Actions runs lint, tests, and the production build. The repository's default branch and required status checks must be configured in GitHub settings.
