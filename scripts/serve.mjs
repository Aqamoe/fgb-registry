#!/usr/bin/env node
/**
 * 本地预览用的小静态服务。
 *
 * 为什么不能直接双击 dist/index.html：页面要用 fetch 读 modules.json，
 * file:// 下会被 CORS 拦掉。另外这里顺便模拟 GitHub Pages 的无扩展名路由。
 *
 *   node scripts/serve.mjs        → http://127.0.0.1:8787/
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT ?? 8787);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

if (!existsSync(ROOT)) {
  console.error('dist/ 还不存在，先跑 node scripts/build-registry.mjs');
  process.exit(1);
}

createServer((req, res) => {
  const clean = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const target = path.join(ROOT, clean === '/' ? 'index.html' : clean);
  if (!target.startsWith(ROOT) || !existsSync(target) || statSync(target).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(target).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`registry 预览：http://127.0.0.1:${PORT}/`);
  console.log(`宿主可用：FGB_MODULE_REGISTRY=http://127.0.0.1:${PORT}/registry.json`);
});
