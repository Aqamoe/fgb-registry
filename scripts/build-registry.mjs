#!/usr/bin/env node
/**
 * fgb-registry 构建脚本
 * =====================
 * 把 modules/*.json 里声明的 GitHub 仓库聚合成一份静态 JSON，输出到 dist/：
 *
 *   dist/modules.json   扁平数组，字段名与 registry.vrcft.io 完全一致 ——
 *                       FaceGaze Bridge 现有的模块库客户端可以直接读，不用改代码
 *   dist/modules        同一份内容，用于保持 /modules 这种无扩展名路径
 *   dist/registry.json  带 schemaVersion / generatedAt 信封的同一份数据，给工具和网页用
 *
 * 为什么要有这个脚本，而不是让客户端直接调 GitHub API：
 *   未认证的 GitHub API 只有 60 次/小时/IP，一个模块就要 2~3 次请求，
 *   模块库页面一刷新就废。这里在 CI 里带 token 抓一次（5000 次/小时），
 *   客户端只读一个被 CDN 缓存的文件。
 *
 * 用法：
 *   node scripts/build-registry.mjs            # 本地试跑
 *   node scripts/build-registry.mjs --strict   # CI 用：有任何校验/下载失败即退出非零
 *
 * 环境变量：
 *   GITHUB_TOKEN        可选。带上可以大幅提高速率上限，private 仓库也能读。
 *   GITHUB_API_BASE     可选。改成 mock 服务地址便于离线测。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST_DIR = path.join(ROOT, 'modules');

const STRICT = process.argv.includes('--strict');
const API = (process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();

const warnings = [];
const errors = [];

const warn = (message) => {
  warnings.push(message);
  console.warn(`  ! ${message}`);
};
const fail = (message) => {
  errors.push(message);
  console.error(`  x ${message}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

// ---------------------------------------------------------------- GitHub API

function ghHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'fgb-registry-builder',
    'x-github-api-version': '2022-11-28',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  return headers;
}

async function ghJson(route) {
  const url = route.startsWith('http') ? route : `${API}${route}`;
  let last = 'unknown';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers: ghHeaders() });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');
    last = `${res.status} ${res.statusText}`.trim();
    if (body) last += ` — ${body.slice(0, 200).replace(/\s+/g, ' ')}`;

    const retryable = res.status === 403 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 3) break;

    const retryAfter = Number(res.headers.get('retry-after'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    let waitMs = 3000;
    if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = retryAfter * 1000;
    else if (Number.isFinite(reset) && reset > 0) waitMs = reset * 1000 - Date.now();
    waitMs = Math.min(Math.max(waitMs, 1000), 65000);

    console.warn(`  · ${last}，${Math.round(waitMs / 1000)}s 后重试（第 ${attempt + 1} 次）`);
    await sleep(waitMs);
  }
  throw new Error(last);
}

// ------------------------------------------------------------------- SemVer
// 只需要"哪个 tag 更新"，不引入依赖。预发布按 semver 规则排在正式版之前。

function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(raw).trim(),
  );
  if (!match) return null;
  const pre = match[4] ?? '';
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${pre ? `-${pre}` : ''}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
  };
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && b.pre) return 1;
  if (a.pre && !b.pre) return -1;
  return a.pre.localeCompare(b.pre, 'en');
}

// ------------------------------------------------------------------- 抓取层

async function getRepo(repo) {
  return ghJson(`/repos/${repo}`);
}

async function listReleases(repo, maxPages) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await ghJson(`/repos/${repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function hashRemoteAsset(url, sizeLimit) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`资产下载失败 ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (sizeLimit && declared > sizeLimit) {
    throw new Error(`资产 ${declared} 字节，超过上限 ${sizeLimit}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (sizeLimit && buffer.length > sizeLimit) {
    throw new Error(`资产 ${buffer.length} 字节，超过上限 ${sizeLimit}`);
  }
  return {
    md5: createHash('md5').update(buffer).digest('hex'),
    sha256: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
  };
}

/**
 * 上次构建的哈希复用表。CI 每次都是干净检出，但 dist/ 是提交回仓库的，
 * 所以能从上一版产物里把 md5/sha256 捡回来，省掉重复下载。
 */
function buildHashCache(previousEntries) {
  const cache = new Map();
  for (const entry of previousEntries) {
    if (!entry?.ModuleId || !entry?.DownloadUrl) continue;
    const key = `${entry.ModuleId}@${entry.Version}@${entry.DownloadUrl}`;
    if (entry.FileHash) {
      cache.set(key, {
        md5: String(entry.FileHash),
        sha256: entry.Sha256 ? String(entry.Sha256) : '',
        size: Number(entry.SizeBytes) || 0,
      });
    }
  }
  return cache;
}

// --------------------------------------------------------------------- 主流程

function validateManifest(manifest, file) {
  const problems = [];
  const need = (field) => {
    const value = manifest[field];
    if (typeof value !== 'string' || value.trim() === '') problems.push(`缺少 ${field}`);
  };
  need('moduleId');
  need('name');
  need('author');
  need('repo');
  need('dll');
  if (manifest.repo && !/^[\w.-]+\/[\w.-]+$/.test(manifest.repo)) {
    problems.push(`repo 应为 owner/name，当前是 ${manifest.repo}`);
  }
  if (manifest.assetPattern) {
    try {
      new RegExp(manifest.assetPattern);
    } catch {
      problems.push(`assetPattern 不是合法正则：${manifest.assetPattern}`);
    }
  }
  for (const problem of problems) fail(`${path.basename(file)}: ${problem}`);
  return problems.length === 0;
}

function matchAssets(release, manifest) {
  const pattern = manifest.assetPattern ? new RegExp(manifest.assetPattern) : null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.filter((asset) => {
    if (pattern) return pattern.test(asset.name);
    return /\.(zip|dll)$/i.test(asset.name);
  });
}

async function collectModule(manifest, repoCache, releaseCache, hashCache, config) {
  const repoName = manifest.repo;
  if (!repoCache.has(repoName)) repoCache.set(repoName, await getRepo(repoName));
  const repo = repoCache.get(repoName);

  if (repo.archived) warn(`${manifest.name}: 仓库已归档，模块仍会列出`);
  if (repo.private) warn(`${manifest.name}: 仓库是私有的，下载链接对公众不可用`);

  if (!releaseCache.has(repoName)) {
    releaseCache.set(repoName, await listReleases(repoName, config.maxReleasePages ?? 3));
  }
  const releases = releaseCache.get(repoName);

  const prefix = manifest.tagPrefix ?? 'v';
  const candidates = [];
  for (const release of releases) {
    if (release.draft) continue;
    const tag = release.tag_name ?? '';
    if (prefix && !tag.startsWith(prefix)) continue;
    const version = parseVersion(prefix ? tag.slice(prefix.length) : tag);
    if (!version) continue;
    if (release.prerelease && !manifest.allowPrerelease) continue;
    candidates.push({ release, version });
  }

  if (candidates.length === 0) {
    warn(`${manifest.name}: 没有找到符合 ${prefix}<semver> 的 Release，暂时不上架`);
    return null;
  }
  candidates.sort((a, b) => compareVersion(b.version, a.version));

  const latest = candidates[0];
  const latestAssets = matchAssets(latest.release, manifest);
  const asset = latestAssets[0];
  if (!asset) {
    warn(`${manifest.name}: ${latest.release.tag_name} 里没有匹配的资产，暂时不上架`);
    return null;
  }

  let downloads = 0;
  for (const candidate of candidates) {
    for (const matched of matchAssets(candidate.release, manifest)) {
      downloads += Number(matched.download_count ?? 0);
    }
  }

  const cacheKey = `${manifest.moduleId}@${latest.version.text}@${asset.browser_download_url}`;
  let hashes = hashCache.get(cacheKey) ?? null;
  if (!hashes && !manifest.skipHash) {
    try {
      hashes = await hashRemoteAsset(asset.browser_download_url, config.maxAssetBytes ?? 67108864);
    } catch (error) {
      if (STRICT) fail(`${manifest.name}: 无法计算 ${asset.name} 的哈希 — ${error.message}`);
      else warn(`${manifest.name}: 无法计算哈希，安装时将无法校验完整性 — ${error.message}`);
      hashes = null;
    }
  }

  // GitHub 给的 digest 只有 sha256，宿主要的是 MD5，两者都要。
  // 下载失败时至少把 digest 里的 sha256 留下，别整条记录空着。
  const digestSha =
    typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
      ? asset.digest.slice('sha256:'.length)
      : '';
  const sha256 = hashes?.sha256 || digestSha;
  const size = hashes?.size || Number(asset.size) || 0;

  const iconPath = manifest.icon ? String(manifest.icon).replace(/^\/+/, '') : '';
  const iconUrl = iconPath
    ? `https://cdn.jsdelivr.net/gh/${repoName}@${manifest.iconBranch ?? 'main'}/${iconPath}`
    : '';

  // 字段名严格对齐 registry.vrcft.io。宿主那边的解析器只认扁平标量，
  // 所以 capabilities 之类必须拼成字符串，绝不能放数组/对象。
  const entry = {
    ModuleId: manifest.moduleId,
    ModuleName: manifest.name,
    AuthorName: manifest.author,
    Version: latest.version.text,
    ModuleDescription: manifest.description ?? repo.description ?? '',
    UsageInstructions: manifest.usage ?? '',
    ModulePageUrl: manifest.page ?? `https://github.com/${repoName}`,
    DownloadUrl: asset.browser_download_url,
    DllFileName: manifest.dll,
    LastUpdated: latest.release.published_at ?? '',
    Downloads: downloads,
  };

  // FileHash 在宿主的实现里是 MD5（BCrypt MD5 比对），别填 sha256 —— 会被判为
  // 「哈希不一致」直接拒绝安装。
  if (hashes?.md5) entry.FileHash = hashes.md5;

  // 以下是扩展字段：宿主会忽略，网页/以后的新客户端可以用。
  entry.AbiVersion = Number(manifest.abiVersion ?? 0) || 0;
  if (Array.isArray(manifest.capabilities) && manifest.capabilities.length) {
    entry.Capabilities = manifest.capabilities.join(',');
  }
  if (manifest.roleHint) entry.RoleHint = manifest.roleHint;
  if (sha256) entry.Sha256 = sha256;
  if (size) entry.SizeBytes = size;
  entry.Repo = repoName;
  if (iconUrl) entry.IconUrl = iconUrl;
  entry.Stars = Number(repo.stargazers_count ?? 0);
  entry.UpdatedAt = repo.pushed_at ?? latest.release.published_at ?? '';
  entry.Prerelease = latest.release.prerelease ? 1 : 0;
  entry.Featured = manifest.featured ? 1 : 0;

  return entry;
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if ((b.Featured ?? 0) !== (a.Featured ?? 0)) return (b.Featured ?? 0) - (a.Featured ?? 0);
    if ((b.Downloads ?? 0) !== (a.Downloads ?? 0)) return (b.Downloads ?? 0) - (a.Downloads ?? 0);
    return String(a.ModuleName).localeCompare(String(b.ModuleName), 'zh');
  });
}

async function main() {
  console.log(`fgb-registry · ${TOKEN ? '已带 token' : '未带 token（60 次/小时，仅够本地试跑）'}`);

  const config = await readJson(path.join(ROOT, 'config.json'));
  if (!existsSync(MANIFEST_DIR)) {
    console.error(`找不到 modules 目录：${MANIFEST_DIR}`);
    process.exit(1);
  }

  const files = (await readdir(MANIFEST_DIR))
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort();

  if (files.length === 0) {
    console.error('modules/ 下没有任何清单，没什么可构建的');
    process.exit(1);
  }

  let previousEntries = [];
  const previousPath = path.join(DIST, 'modules.json');
  if (existsSync(previousPath)) {
    try {
      const parsed = await readJson(previousPath);
      if (Array.isArray(parsed)) previousEntries = parsed;
    } catch {
      // 上一版产物坏了就当没有，重新算哈希
    }
  }
  const hashCache = buildHashCache(previousEntries);

  const repoCache = new Map();
  const releaseCache = new Map();
  const entries = [];
  const seenIds = new Set();

  for (const file of files) {
    const fullPath = path.join(MANIFEST_DIR, file);
    let manifest;
    try {
      manifest = await readJson(fullPath);
    } catch (error) {
      fail(`${file}: JSON 语法错误 — ${error.message}`);
      continue;
    }

    console.log(`\n· ${manifest.name ?? file}  (${manifest.repo ?? '?'})`);
    if (!validateManifest(manifest, fullPath)) continue;
    if (seenIds.has(manifest.moduleId)) {
      fail(`${file}: ModuleId 与其它清单重复 — ${manifest.moduleId}`);
      continue;
    }
    seenIds.add(manifest.moduleId);

    try {
      const entry = await collectModule(manifest, repoCache, releaseCache, hashCache, config);
      if (entry) {
        entries.push(entry);
        console.log(
          `  ok ${entry.Version} · ${entry.Downloads} 次下载 · ${entry.LastUpdated ?? ''}` +
            (entry.FileHash ? ` · md5 ${entry.FileHash.slice(0, 8)}…` : ' · 无哈希'),
        );
      }
    } catch (error) {
      fail(`${manifest.name}: ${error.message}`);
    }
  }

  sortEntries(entries);
  if (entries.length === 0) {
    console.error('\n没有任何模块进入产物，构建失败');
    process.exit(1);
  }

  await mkdir(DIST, { recursive: true });

  const arrayJson = `${JSON.stringify(entries, null, 2)}\n`;
  await writeFile(path.join(DIST, 'modules.json'), arrayJson, 'utf8');
  await writeFile(path.join(DIST, 'modules'), arrayJson, 'utf8');
  await writeFile(
    path.join(DIST, 'registry.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        generator: 'fgb-registry',
        title: config.title ?? 'Module registry',
        count: entries.length,
        modules: entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const siteHtml = path.join(ROOT, 'site', 'index.html');
  if (existsSync(siteHtml)) {
    await copyFile(siteHtml, path.join(DIST, 'index.html'));
  }
  await writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');

  console.log(`\n写出 ${entries.length} 个模块 → dist/`);
  if (warnings.length) console.log(`警告 ${warnings.length} 条`);
  if (errors.length) {
    console.error(`错误 ${errors.length} 条`);
    if (STRICT) process.exit(1);
  }
}

main().catch((error) => {
  console.error(`构建中断：${error.message}`);
  process.exit(1);
});
