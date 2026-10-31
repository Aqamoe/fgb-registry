# fgb-registry

FaceGaze Bridge 的**公开模块库索引**。纯 GitHub 仓库实现，不需要服务器、数据库或自建站点。

- 线上地址：<https://aqamoe.github.io/fgb-registry/>
- 宿主消费的接口：<https://aqamoe.github.io/fgb-registry/modules.json>

它做的事只有一件：把 `modules/*.json` 里登记的 GitHub 仓库，聚合为一份宿主可以直接消费的
静态 JSON，发布到 GitHub Pages。

```
各模块仓库的 Release ──► Actions（带 token 抓 GitHub API）──► dist/modules.json ──► 宿主的模块库页面
```

## 为什么让 CI 抓，而不是客户端直连

未认证的 GitHub API 只有 **60 次/小时/IP**，一个模块就要 2~3 次请求，客户端一刷新就废。
这里的做法是：CI 带 token 抓一次（5000 次/小时），把结果落成静态文件，客户端读 CDN 上的那一个文件。
下载次数、更新时间、版本号都因此变成"快照值"而不是实时值 —— 这正是任何模块库网站的做法。

## 目录

```
modules/            每个模块一个清单，社区提 PR 就是在这里加文件
scripts/
  build-registry.mjs  聚合器：读清单 → 查 Release → 算哈希 → 写 dist/
  serve.mjs           本地预览用静态服务（file:// 下 fetch 会被 CORS 拦）
site/index.html     人看的网页，构建时抄进 dist/
dist/               产物，由 Actions 提交回仓库（jsDelivr 的备用分发路径依赖它）
config.json         站点标题、分页上限、单文件大小上限
```

## 本地跑

```bash
node scripts/build-registry.mjs     # 生成 dist/
node scripts/serve.mjs              # http://127.0.0.1:8787/
```

带 token 可以跑更多模块、也不会撞限流：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
node scripts/build-registry.mjs --strict
```

`--strict` 下任何清单校验失败、Release 抓不到、哈希算不出来都会让进程退出非零，CI 用的就是这个。

## 产物

| 文件 | 内容 | 谁用 |
|---|---|---|
| `dist/modules.json` | **扁平数组**，字段名与 `registry.vrcft.io/modules` 完全一致 | 宿主模块库客户端 |
| `dist/modules` | 同一份内容，保住 `/modules` 这种无扩展名路径 | 想沿用原路径风格的部署 |
| `dist/registry.json` | `{ schemaVersion, generatedAt, modules[] }` 信封 | 网页、工具、未来的新客户端 |
| `dist/index.html` | 浏览页面 | 人 |

字段来源：

| 字段 | 来源 |
|---|---|
| `ModuleId` / `ModuleName` / `AuthorName` / `DllFileName` | 清单，必须与模块包内 `fgb-native.json` 一致，否则宿主认不出"已安装" |
| `Version` | 最新符合 `tagPrefix + semver` 的 tag（去掉前缀） |
| `DownloadUrl` | 该 Release 里匹配 `assetPattern` 的资产直链 |
| `LastUpdated` | Release 的 `published_at` |
| `Downloads` | 该模块**所有**匹配资产的 `download_count` 累加（GitHub 唯一的计数口径，按版本累加，不会被新版本清零） |
| `FileHash` | **MD5**，见下面的坑 |
| `ModuleDescription` / `UsageInstructions` / `ModulePageUrl` | 清单 |
| `AbiVersion` / `Capabilities` / `Sha256` / `SizeBytes` / `Repo` / `IconUrl` / `Stars` / `UpdatedAt` / `Featured` | 扩展字段，宿主忽略，网页用 |

## 上架一个模块

在 `modules/` 新建一个 `<模块名>.json`：

```json
{
  "moduleId": "com.example.my-module",
  "name": "My Module",
  "author": "Your Name",
  "repo": "you/MyModuleRepo",
  "page": "https://github.com/you/MyModuleRepo",
  "dll": "my-module.dll",
  "description": "一句话说明它接什么硬件、输出什么。",
  "usage": "装完后要在哪里启用、要注意什么。",
  "abiVersion": 2,
  "capabilities": ["expression"],
  "roleHint": "expression",
  "tagPrefix": "v",
  "assetPattern": "^my-module-.*\\.zip$",
  "icon": "module/icon.svg",
  "iconBranch": "main"
}
```

提交 PR 即上架。合并后 `push` 触发构建，几分钟内出现在页面和 JSON 里。

要求：

- Release 的 tag 是 `v1.2.3` 这种纯 semver（`v` 前缀可换，见 `tagPrefix`）。
- Release 里有一个资产能被 `assetPattern` 匹配，且是**打包好的 zip**（含 `fgb-native.json` + DLL），
  或者直接是单个 DLL。
- 仓库是公开的。`DownloadUrl` 必须是 `https://`，否则宿主会直接丢弃这条记录。

## 发布

1. 在 GitHub 新建空仓库（例如 `Aqamoe/fgb-registry`），把本目录推上去。
2. Settings → Pages → Source 选 **GitHub Actions**（不是 Deploy from a branch）。
3. 跑一次 `registry` workflow。构建完 `dist/` 会提交回来，Pages 同时上线。
4. 想要 `registry.yourdomain.com` 这种地址：Pages 里填 Custom domain，DNS 加一条 CNAME。
   也可以用 Cloudflare 代理一层做国内加速 —— 仍然不用自己写后端。

## 宿主怎么接

FaceGaze Bridge 已经内置了 `registry.vrcft.io/modules` 的客户端
（`src/vrcft/module_library.cpp`），它读环境变量 `FGB_MODULE_REGISTRY` 覆盖地址：

```powershell
$env:FGB_MODULE_REGISTRY = "https://fgb-registry.pages.dev/modules.json"
```

确认没问题后，把 `kDefaultRegistryUrl` 改成自己的地址（或者干脆改成"自己的库 + 官方库合并"），
用户就默认看到你们的模块库了，客户端代码一行都不用动。

本地联调：`node scripts/serve.mjs` 后把上面那个环境变量指向 `http://127.0.0.1:8787/modules.json`
（宿主只放行 `https://` 和 `127.0.0.1` / `localhost` 的下载链接，这个地址正好合规）。

## 踩过的坑

**`FileHash` 是 MD5，不是 SHA256。** 宿主的实现是 `md5_file()` + 小写比对，填 sha256 会被判成
"哈希不一致"直接拒绝安装。GitHub 只给 sha256 的 `digest`，所以 MD5 必须把资产下载下来算一次
（脚本会用上一版 `dist/modules.json` 里的结果复用，不会每轮重复下）。

**模块对象里只放扁平标量，别放数组或嵌套对象。** 宿主的解析器（`parse_registry_json`）遇到
数组/对象会整段跳过、读不到内容，所以 `capabilities` 在产物里被拼成 `"expression,eyes"`。
这一条是实现细节，不是协议限制，但保持扁平最省事。

**`Downloads` 是累计快照，不等于安装量。** 通过 `releases/latest/download/...` 的跳转下载也会计入；
但用户从第三方镜像拿包不会计入。另外**构建过程本身也算一次下载** —— 为了算 MD5 要拉一次资产
（有上一版产物缓存，同一版本只拉一次），所以每个版本的数字会被自己抬高 1~2。真要统计安装量，
得让客户端上报，那就需要后端了。

**Actions 的 cron 有延迟**，`*/6 * * * *` 实际可能晚十几分钟。要准点就让模块仓库发版后
打 `repository_dispatch`（见下）。

**国内访问**：`*.github.io` 和 `raw.githubusercontent.com` 都不稳。
`https://cdn.jsdelivr.net/gh/Aqamoe/fgb-registry@main/dist/modules.json` 通常更通，
所以 `dist/` 才要提交回仓库。

## 发版即上架（可选）

在各模块仓库的发版 workflow 末尾加一步：

```yaml
- name: 通知模块库
  env:
    GH_TOKEN: ${{ secrets.REGISTRY_DISPATCH_TOKEN }}   # 只有 fgb-registry 的 contents 权限
  run: |
    gh api repos/Aqamoe/fgb-registry/dispatches \
      -f event_type=module-released
```

## 安全

模块是会被加载进宿主进程的 DLL，这个仓库本质上是**白名单**：

- 只有经过 review 的 `modules/*.json` 才会被聚合，任何人不能靠"自己发个 Release"挤进来。
- 每个资产都会被下载并计算哈希，`FileHash` 写进产物，宿主安装时比对。
- 已知弱点：MD5 只能防传输损坏与"仓库被换了包没换清单"，防不了有意的碰撞攻击。
  后续建议宿主支持 `Sha256` 字段（`dist/` 里已经带上），并对官方模块做签名。

## 许可

MIT。模块本身各自的许可证见其仓库。
