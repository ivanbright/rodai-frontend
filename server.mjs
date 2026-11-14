import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

if (!existsSync(join(root, 'index.html'))) {
  throw new Error('Frontend build is missing. Run `npm run build` before starting the server.');
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end('Bad request');
    return;
  }

  const relativePath = normalize(pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, '');
  let filePath = join(root, relativePath);
  let fallback = false;
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    if (pathname.startsWith('/assets/') || extname(pathname)) {
      response.writeHead(404).end('Not found');
      return;
    }
    filePath = join(root, 'index.html');
    fallback = true;
  }

  const isBuildAsset = !fallback && pathname.startsWith('/assets/');
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': isBuildAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  pipeline(createReadStream(filePath), response, (error) => {
    if (error && !response.headersSent) response.writeHead(500).end('Unable to serve asset');
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`RodAI frontend listening on 0.0.0.0:${port}`);
});
