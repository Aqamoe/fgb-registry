#!/usr/bin/env node
/**
 * fgb-registry 构建脚本（schema v2）
 * ================================
 * 把 modules/*.json 里声明的 GitHub 仓库聚合成 dist/registry.json —— FaceGaze Bridge
 * 原生模块库读的那一份文件。
 *
 * 为什么要有这个脚本，而不是让客户端直接调 GitHub API：
 *   未认证的 GitHub API 只有 60 次/小时/IP，一个模块就要 2~3 次请求，
 *   模块库页面一刷新就废。这里在 CI 里带 token 抓一次（5000 次/小时），
 *   客户端只读一个被 CDN 缓存的文件。
 *
 * v2 与 registry.vrcft.io 的老格式**不兼容**，这是有意的：
 *   · 老格式是"扁平标量数组"，能力、版本历史、兼容性都得塞进字符串里；
 *   · 这里直接给结构化数据（数组、对象、布尔），宿主可以正经解析。
 *
 * 用法：
 *   node scripts/build-registry.mjs            # 本地试跑
 *   node scripts/build-registry.mjs --strict   # CI 用：校验/下载/包内清单不一致即失败
 *   node scripts/build-registry.mjs --offline  # 只用缓存，不联网（改网页样式时用）
 *
 * 环境变量：
 *   GITHUB_TOKEN        可选。带上可以大幅提高速率上限，private 仓库也能读。
 *   GITHUB_API_BASE     可选。改成 mock 服务地址便于离线测。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const MANIFEST_DIR = path.join(ROOT, 'modules');
const SCHEMA_FILE = path.join(ROOT, 'schema', 'registry.schema.json');

const SCHEMA_VERSION = 2;
const GENERATOR = 'fgb-registry/2.0.0';

const STRICT = process.argv.includes('--strict');
const OFFLINE = process.argv.includes('--offline');
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

async function downloadAsset(url, sizeLimit) {
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
  return buffer;
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

// ------------------------------------------------------------------ zip 解析
// 只为了一件事：把包里的 fgb-native.json 读出来，核对清单与包是否对得上。
// 只用 Node 自带的 zlib，不引依赖。

function findSignature(buffer, signature, from, to) {
  for (let i = to - 4; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function readZipEntryJson(buffer, wantedBasenames) {
  const eocd = findSignature(buffer, 0x06054b50, Math.max(0, buffer.length - 66560), buffer.length);
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录结构异常');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const basename = name.split('/').pop()?.toLowerCase() ?? '';
    if (wantedBasenames.includes(basename)) {
      if (compressedSize === 0xffffffff) throw new Error('不支持 zip64 内的清单文件');
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地文件头异常');
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(dataStart, dataStart + compressedSize);
      const data = method === 0 ? raw : inflateRawSync(raw);
      const text = data.toString('utf8').replace(/^\uFEFF/, '');
      return { name, json: JSON.parse(text) };
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * 核对包内 fgb-native.json 与清单声明是否一致。
 * 这一步是模块库的"上架审核"，比安装时才失败要好得多。
 */
function verifyPackage(bytes, manifest, version) {
  const issues = [];
  let found;
  try {
    found = readZipEntryJson(bytes, ['fgb-native.json', 'module.json']);
  } catch (error) {
    warn(`${manifest.name}: 包内校验跳过（${error.message}）`);
    return { issues, inside: null };
  }
  if (!found) {
    warn(`${manifest.name}: 包里没有 fgb-native.json，宿主要靠清单补元数据`);
    return { issues, inside: null };
  }

  const inside = found.json ?? {};
  if (inside.ModuleId && inside.ModuleId !== manifest.id) {
    issues.push(`包内 ModuleId=${inside.ModuleId} 与清单 id=${manifest.id} 不一致`);
  }
  if (inside.Version && inside.Version !== version) {
    issues.push(`包内 Version=${inside.Version} 与 tag 推导的 ${version} 不一致`);
  }
  if (manifest.entry && inside.DllFileName && inside.DllFileName !== manifest.entry) {
    issues.push(`包内 DllFileName=${inside.DllFileName} 与清单 entry=${manifest.entry} 不一致`);
  }
  if (manifest.requires?.abi && inside.AbiVersion && inside.AbiVersion !== manifest.requires.abi) {
    issues.push(`包内 AbiVersion=${inside.AbiVersion} 与清单 requires.abi=${manifest.requires.abi} 不一致`);
  }
  if (issues.length === 0) {
    console.log(`  ✓ 包内 fgb-native.json 与清单一致（${found.name}）`);
  }
  return { issues, inside };
}

// --------------------------------------------------------------------- 抓取层

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

function matchAssets(release, manifest) {
  const pattern = manifest.assetPattern ? new RegExp(manifest.assetPattern) : null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.filter((asset) => {
    if (pattern) return pattern.test(asset.name);
    return /\.(zip|dll)$/i.test(asset.name);
  });
}

function truncate(text, limit) {
  const clean = String(text ?? '').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

// ---------------------------------------------------------------- 单模块聚合

function validateManifest(manifest, file) {
  const problems = [];
  const needString = (field) => {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      problems.push(`缺少 ${field}`);
    }
  };
  needString('id');
  needString('name');
  needString('repo');
  if (manifest.repo && !/^[\w.-]+\/[\w.-]+$/.test(manifest.repo)) {
    problems.push(`repo 应为 owner/name，当前是 ${manifest.repo}`);
  }
  if (!manifest.author || typeof manifest.author.name !== 'string') {
    problems.push('author 需要是 { name, url? } 对象');
  }
  if (manifest.capabilities && !Array.isArray(manifest.capabilities)) {
    problems.push('capabilities 必须是数组');
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

function versionObject({ release, version, asset, manifest, hash, notes }) {
  return {
    version: version.text,
    channel: release.prerelease ? 'beta' : 'stable',
    publishedAt: release.published_at ?? '',
    fileName: asset.name,
    downloadUrl: asset.browser_download_url,
    size: hash?.size || Number(asset.size) || 0,
    sha256: hash?.sha256 ?? '',    abiVersion: Number(manifest.requires?.abi ?? 0) || 0,
    downloads: matchAssets(release, manifest).reduce(
      (sum, matched) => sum + Number(matched.download_count ?? 0),
      0,
    ),
    notes,
    releaseUrl: release.html_url ?? '',
  };
}

async function collectModule(manifest, ctx) {
  const { repoCache, releaseCache, hashCache, config } = ctx;
  const repoName = manifest.repo;

  if (!repoCache.has(repoName)) repoCache.set(repoName, await ghJson(`/repos/${repoName}`));
  const repo = repoCache.get(repoName);
  if (repo.archived) warn(`${manifest.name}: 仓库已归档`);

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
    const assets = matchAssets(release, manifest);
    if (assets.length === 0) continue;
    candidates.push({ release, version, asset: assets[0] });
  }

  if (candidates.length === 0) {
    warn(`${manifest.name}: 没有找到符合 ${prefix}<semver> 的 Release，暂时不上架`);
    return null;
  }
  candidates.sort((a, b) => compareVersion(b.version, a.version));

  const maxVersions = config.maxVersions ?? 10;
  const keep = candidates.slice(0, maxVersions);
  const versions = [];

  for (const candidate of keep) {
    const { release, version, asset } = candidate;
    const cacheKey = `${manifest.id}@${version.text}@${asset.browser_download_url}`;
    let hash = hashCache.get(cacheKey) ?? null;
    let bytes = null;

    if (!hash && !manifest.skipHash && !OFFLINE) {
      try {
        bytes = await downloadAsset(asset.browser_download_url, config.maxAssetBytes ?? 67108864);
        hash = {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        };
      } catch (error) {
        if (STRICT) fail(`${manifest.name} ${version.text}: 无法下载资产 — ${error.message}`);
        else warn(`${manifest.name} ${version.text}: 无法下载资产，缺少 sha256 — ${error.message}`);
        hash = null;
      }
    }

    // 最新版（也是最新稳定版候选）才做包内核对：老版本重新下载没有意义
    if (version === keep[0].version && bytes && !manifest.skipPackageCheck) {
      const { issues } = verifyPackage(bytes, manifest, version.text);
      for (const issue of issues) {
        if (STRICT) fail(`${manifest.name} ${version.text}: ${issue}`);
        else warn(`${manifest.name} ${version.text}: ${issue}`);
      }
    }

    versions.push(
      versionObject({
        release,
        version,
        asset,
        manifest,
        hash,
        notes: truncate(release.body, config.maxNotesChars ?? 2000) || undefined,
      }),
    );
  }

  const stable = versions.find((v) => v.channel === 'stable');
  const latest = stable ?? versions[0];
  if (!stable) warn(`${manifest.name}: 目前只有预发布版本，latest 指向 ${latest.version}`);

  const i18n = {};
  if (manifest.i18n && typeof manifest.i18n === 'object') {
    for (const [locale, values] of Object.entries(manifest.i18n)) {
      if (!values || typeof values !== 'object') continue;
      const entry = {};
      for (const field of ['summary', 'description', 'usage']) {
        if (typeof values[field] === 'string') entry[field] = values[field];
      }
      if (Object.keys(entry).length) i18n[locale] = entry;
    }
  }

  const iconPath = manifest.icon ? String(manifest.icon).replace(/^\/+/, '') : '';
  const icon = iconPath
    ? `https://cdn.jsdelivr.net/gh/${repoName}@${manifest.iconBranch ?? 'main'}/${iconPath}`
    : undefined;

  // 下载量统计所有可匹配的 Release，不只是 keep 里那几版 —— 否则老版本一多就少算
  let totalDownloads = 0;
  for (const candidate of candidates) {
    for (const matched of matchAssets(candidate.release, manifest)) {
      totalDownloads += Number(matched.download_count ?? 0);
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    author: {
      name: manifest.author.name,
      ...(manifest.author.url ? { url: manifest.author.url } : {}),
    },
    summary: manifest.summary ?? '',
    description: manifest.description ?? repo.description ?? '',
    usage: manifest.usage ?? '',
    homepage: manifest.homepage ?? `https://github.com/${repoName}`,
    repo: repoName,
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(icon ? { icon } : {}),
    ...(Array.isArray(manifest.screenshots) && manifest.screenshots.length
      ? { screenshots: manifest.screenshots }
      : {}),
    tags: Array.isArray(manifest.tags) ? manifest.tags : [],
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
    ...(manifest.defaultRole ? { defaultRole: manifest.defaultRole } : {}),
    requires: {
      abi: Number(manifest.requires?.abi ?? 0) || 0,
      ...(manifest.requires?.minHostVersion
        ? { minHostVersion: manifest.requires.minHostVersion }
        : {}),
      os: manifest.requires?.os ?? ['windows'],
      arch: manifest.requires?.arch ?? ['x64'],
    },
    channel: latest.channel,
    featured: Boolean(manifest.featured),
    verified: Boolean(manifest.verified),
    archived: Boolean(repo.archived),
    stats: {
      downloads: totalDownloads,
      stars: Number(repo.stargazers_count ?? 0),
    },
    publishedAt: versions[versions.length - 1]?.publishedAt ?? '',
    updatedAt: repo.pushed_at ?? latest.publishedAt ?? '',
    latest,
    versions,
    ...(Object.keys(i18n).length ? { i18n } : {}),
  };
}

function sortModules(modules) {
  return modules.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.stats.downloads !== b.stats.downloads) return b.stats.downloads - a.stats.downloads;
    return String(a.name).localeCompare(String(b.name), 'zh');
  });
}

// --------------------------------------------------------------------- 主流程

async function loadPrevious() {
  const previousPath = path.join(DIST, 'registry.json');
  if (!existsSync(previousPath)) return { modules: [], generatedAt: '' };
  try {
    const parsed = await readJson(previousPath);
    return {
      modules: Array.isArray(parsed?.modules) ? parsed.modules : [],
      generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : '',
    };
  } catch {
    return { modules: [], generatedAt: '' };
  }
}

function buildHashCache(modules) {
  const cache = new Map();
  for (const module of modules) {
    if (!module?.id) continue;
    for (const version of module.versions ?? []) {
      if (!version?.downloadUrl || !version.sha256) continue;
      cache.set(`${module.id}@${version.version}@${version.downloadUrl}`, {
        sha256: String(version.sha256),
        size: Number(version.size) || 0,
      });
    }
  }
  return cache;
}

async function main() {
  console.log(`fgb-registry · ${TOKEN ? '已带 token' : '未带 token（60 次/小时，仅够本地试跑）'}`);

  const config = await readJson(path.join(ROOT, 'config.json'));
  const files = (await readdir(MANIFEST_DIR))
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort();

  if (files.length === 0) {
    console.error('modules/ 下没有任何清单');
    process.exit(1);
  }

  const previous = await loadPrevious();
  const ctx = {
    config,
    repoCache: new Map(),
    releaseCache: new Map(),
    hashCache: buildHashCache(previous.modules),
  };

  const modules = [];
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
    if (seenIds.has(manifest.id)) {
      fail(`${file}: id 与其它清单重复 — ${manifest.id}`);
      continue;
    }
    seenIds.add(manifest.id);

    try {
      const entry = await collectModule(manifest, ctx);
      if (entry) {
        modules.push(entry);
        const hashState = entry.latest.sha256 ? `sha256 ${entry.latest.sha256.slice(0, 8)}…` : '缺少 sha256';
        console.log(
          `  ok ${entry.latest.version} (${entry.channel}) · ${entry.stats.downloads} 次下载 · ` +
            `${entry.versions.length} 个版本 · ${hashState}`,
        );
      }
    } catch (error) {
      fail(`${manifest.name}: ${error.message}`);
    }
  }

  sortModules(modules);
  if (modules.length === 0) {
    console.error('\n没有任何模块进入产物，构建失败');
    process.exit(1);
  }

  await mkdir(DIST, { recursive: true });

  // 内容没变就不动 generatedAt，否则每 6 小时的定时任务都会产出一个只改时间戳的空提交
  const unchanged =
    previous.modules.length > 0 &&
    JSON.stringify(previous.modules) === JSON.stringify(modules);
  const generatedAt =
    unchanged && previous.generatedAt ? previous.generatedAt : new Date().toISOString();
  if (unchanged) console.log('\n内容与上一版一致，保留 generatedAt（不会产生新提交）');

  const registry = {
    $schema: 'registry.schema.json',
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    generator: GENERATOR,
    registry: {
      title: config.title ?? 'Module registry',
      description: config.description ?? '',
      homepage: config.siteUrl ?? '',
    },
    moduleCount: modules.length,
    modules,
  };

  await writeFile(path.join(DIST, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  if (existsSync(SCHEMA_FILE)) {
    await copyFile(SCHEMA_FILE, path.join(DIST, 'registry.schema.json'));
  }
  const siteHtml = path.join(ROOT, 'site', 'index.html');
  if (existsSync(siteHtml)) {
    await copyFile(siteHtml, path.join(DIST, 'index.html'));
  }
  await writeFile(path.join(DIST, '.nojekyll'), '', 'utf8');

  console.log(`\n写出 ${modules.length} 个模块 → dist/`);
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
