import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, GitHubAdapter, resolveAuth } from './lib/github.mjs';
import { WorkspaceManager, readWorkspaceConfig } from './lib/workspaces.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function checkHost(request) {
  const host = request.headers.host;
  const match = typeof host === 'string' && /^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/i.exec(host);
  const port = match && (match[2] ? Number(match[2]) : 80);
  if (!match || port !== request.socket.localPort) throw new ApiError('Invalid Host. Use localhost or 127.0.0.1 and this server’s actual port.', 403);
  return host;
}
export function checkPost(request, host) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.toLowerCase() !== new URL(`http://${host}`).origin.toLowerCase())
    throw new ApiError('POST requests require a same-origin Origin header.', 403);
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] || ''))
    throw new ApiError('Content-Type must be application/json.', 415);
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    throw new ApiError('Encoded request bodies are not supported.', 415);
}
async function jsonBody(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new ApiError('JSON request body exceeds 64 KB.', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('Request body must be a JSON object.');
  return value;
}
function json(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}
async function staticFile(request, response, publicDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new ApiError('Malformed URL path.'); }
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..'))
    throw new ApiError('Invalid static file path.', 403);
  const root = resolve(publicDir);
  const candidate = resolve(root, `.${decoded.endsWith('/') ? `${decoded}index.html` : decoded}`);
  if (!candidate.startsWith(`${root}${sep}`)) throw new ApiError('Invalid static file path.', 403);
  let target, info;
  try {
    const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!actualTarget.startsWith(`${actualRoot}${sep}`)) throw new ApiError('Static symlink is outside public/.', 403);
    target = actualTarget; info = await stat(target);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new ApiError('File not found.', 404);
    throw error;
  }
  if (!info.isFile()) throw new ApiError('File not found.', 404);
  const content = request.method === 'HEAD' ? null : await readFile(target);
  response.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  response.end(content);
}

export async function createApplication({ rootDir = ROOT, env = process.env, adapter, runner, runnerOptions = {} } = {}) {
  if (!runner) {
    adapter ||= new GitHubAdapter(await resolveAuth(env));
    const configPath = join(env.DATA_DIR ? resolve(rootDir, env.DATA_DIR) : join(rootDir, '.data'), 'config.json');
    runner = new WorkspaceManager({ adapter, configPath, config: await readWorkspaceConfig(configPath, env), runnerOptions });
  }
  const server = http.createServer({ requestTimeout: 20000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = checkHost(request);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new ApiError('Invalid request URL.');
      // Use the raw path for static mapping: URL normalization must not hide traversal attempts.
      const pathname = request.url.split('?')[0];
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'POST') checkPost(request, host);
      if (pathname.startsWith('/api/')) {
        const workspaceId = url.searchParams.has('workspaceId') ? url.searchParams.get('workspaceId') : undefined;
        if (request.method === 'GET' && pathname === '/api/state') return json(response, 200, await runner.refresh({ workspaceId, force: url.searchParams.get('refresh') === '1' }));
        const inputMatch = /^\/api\/workflows\/(\d+)\/inputs$/.exec(pathname);
        if (request.method === 'GET' && inputMatch) return json(response, 200, await runner.inputs(Number(inputMatch[1]), url.searchParams.get('ref') ?? undefined, workspaceId));
        if (request.method === 'POST') {
          const body = await jsonBody(request);
          if (pathname === '/api/config') return json(response, 200, await runner.configure(body.repository));
          if (runner instanceof WorkspaceManager) {
            if (pathname === '/api/workspaces/select') return json(response, 200, await runner.select(body.workspaceId));
            if (pathname === '/api/workspaces/branch') return json(response, 200, await runner.saveBranch(body.workspaceId, body.branch));
            if (pathname === '/api/workspaces/remove') return json(response, 200, await runner.remove(body.workspaceId));
          }
          if (pathname === '/api/queue') return json(response, 202, await runner.startQueue(body));
          if (pathname === '/api/queue/stop') return json(response, 200, runner.stop(body.workspaceId));
        }
        throw new ApiError('API route not found.', 404);
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError('Method not allowed.', 405);
      await staticFile(request, response, join(rootDir, 'public'), pathname);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof ApiError ? runner.message(error) : 'Unexpected server error.';
      json(response, status, { error: message, ...(error.code === 'WORKSPACE_NOT_FOUND' ? { code: error.code } : {}) });
    }
  });
  return {
    server, runner,
    async close() {
      // Stop pending work before closing connections; never cancel a GitHub workflow.
      const drained = new Promise(resolveClose => server.listening ? server.close(resolveClose) : resolveClose());
      server.closeIdleConnections();
      await runner.close();
      await drained;
    },
  };
}

export async function main(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const app = await createApplication({ env });
  await new Promise((resolveListen, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', resolveListen);
  });
  console.log(`Workflow runner at http://127.0.0.1:${app.server.address().port} (${app.runner.mode === 'setup' ? 'connect a repository to get started' : 'GitHub connected'})`);
  console.log('Queues are memory-only. Restarting loses monitoring; inspect GitHub before starting another batch.');
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return; closing = true;
    await app.close();
    process.exitCode = 0;
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
