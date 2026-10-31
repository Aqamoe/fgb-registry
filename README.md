# fgb-registry

FaceGaze Bridge **原生模块**的公开索引。纯 GitHub 仓库实现，不需要服务器、数据库或自建站点。

- 线上：<https://aqamoe.github.io/fgb-registry/>
- 接口：<https://aqamoe.github.io/fgb-registry/registry.json>
- 结构定义：<https://aqamoe.github.io/fgb-registry/registry.schema.json>（JSON Schema，宿主照着写解析就行）

```
各模块仓库的 Release ──► Actions（带 token 抓 GitHub API + 校验包内容）
                              │
                              ▼
                        dist/registry.json ──► 宿主模块库页面
```

## 这个库不兼容 registry.vrcft.io 的老格式

这是有意为之。老格式是「扁平数组 + 全部标量」，能力列表得拼成 `"expression,eyes"`，
版本历史、通道、兼容性、更新说明全都塞不进去。既然宿主的原生模块库还没实现，
就没必要迁就它 —— 直接用结构化 schema v2：

| 能表达 | 老格式 | 这里 |
|---|---|---|
| 能力、标签、截图 | 拼字符串 | 真数组 |
| 版本历史 / 回滚 | 无 | `versions[]` |
| 稳定版 / 测试版 | 无 | `channel` |
| 完整性校验 | MD5（弱） | `sha256` |
| ABI / 系统 / 架构要求 | 无 | `requires` |
| 更新说明 | 无 | `notes`（markdown） |
| 多语言 | 无 | `i18n` |

老的那套 `dist/modules`、`dist/modules.json` 已经删掉，别再引用。

## 目录

```
modules/              每个模块一个清单，社区提 PR 就是在这里加文件
schema/
  registry.schema.json  产物结构定义，构建时抄进 dist/ 一起发布
scripts/
  build-registry.mjs    聚合器：读清单 → 查 Release → 校验包内容 → 写 dist/
  serve.mjs             本地预览用静态服务（file:// 下 fetch 会被 CORS 拦）
site/index.html       人看的网页，构建时抄进 dist/
dist/                 产物，由 Actions 提交回仓库（jsDelivr 的备用分发路径依赖它）
config.json           标题、版本数上限、单文件大小上限
```

## 本地跑

```bash
node scripts/build-registry.mjs     # 生成 dist/
node scripts/serve.mjs              # http://127.0.0.1:8787/
```

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"        # 提高限流上限，多个模块时必要
node scripts/build-registry.mjs --strict
```

- `--strict`：清单校验失败、Release 抓不到、资产下不下来、**包内清单与声明不一致**，全都退出非零。CI 用这个。
- `--offline`：只用上一版产物里的 sha256 缓存，不联网。改网页样式时用。

## 产物结构

顶层：

```json
{
  "$schema": "registry.schema.json",
  "schemaVersion": 2,
  "generatedAt": "2026-10-31T10:54:47.829Z",
  "generator": "fgb-registry/2.0.0",
  "registry": { "title": "...", "description": "...", "homepage": "..." },
  "moduleCount": 1,
  "modules": [ ... ]
}
```

模块级（列表页用）：

| 字段 | 说明 |
|---|---|
| `id` | 必须等于包内 `fgb-native.json` 的 `ModuleId`。宿主用它判定「已安装 / 待升级」 |
| `name` / `author{name,url}` / `summary` / `description` / `usage` | 展示文本；`summary` 给列表，`description` / `usage` 给详情页，允许 markdown |
| `capabilities[]` | `expression` / `eyes` / `gaze` / `head`，宿主据此做角色分配 |
| `defaultRole` | 建议默认分配的角色 |
| `requires{abi,minHostVersion?,os[],arch[]}` | 加载前判断；`abi` 必须与宿主一致 |
| `channel` | `stable` / `beta`，指 `latest` 所在通道 |
| `verified` | 是否经过本库审核。false 时宿主应给出提示 |
| `archived` | 上游仓库已归档 |
| `stats{downloads,stars}` | GitHub 的累计下载与 star |
| `latest` / `versions[]` | 见下 |

版本级（`latest` 与 `versions[]` 元素同构）：

| 字段 | 说明 |
|---|---|
| `version` | 严格 semver，**用语义比较，别比字符串** |
| `channel` | `stable` / `beta`（对应 GitHub 的 prerelease） |
| `downloadUrl` / `fileName` / `size` | 直链、文件名、字节数（进度条用） |
| `sha256` | 小写十六进制。**安装前必须校验，不匹配就中止** |
| `abiVersion` | 包内声明，用于加载前判断 |
| `downloads` / `publishedAt` / `releaseUrl` / `notes` | 该版本的下载数、发布时间、Release 页、更新说明 |

## 宿主接入要点

1. `GET registry.json`，带 `If-None-Match` / `ETag`，304 就用缓存。
2. `schemaVersion !== 2` → 整体拒绝，别猜着解析（以后加字段靠这个兜底）。
3. 比对 `latest.version` 与本地 `fgb-native.json` 的 `Version`（semver 比较）→ 显示「安装 / 更新」。
4. 下载到临时文件，**先算 sha256、核对 `size`**，再解压。
5. 解压后读包内 `fgb-native.json`，核对 `ModuleId === entry.id`、`AbiVersion === requires.abi`，
   不一致就拒绝安装（防止包里塞了别的东西）。
6. 落盘到模块仓，写 `enabled` / `source=registry` / `installed_at`，与手动装包走同一条路径。

地址支持环境变量覆盖（`src/vrcft/module_library.cpp`）：

```powershell
$env:FGB_MODULE_REGISTRY = "https://aqamoe.github.io/fgb-registry/registry.json"
```

本地联调就指 `http://127.0.0.1:8787/registry.json`。

## 上架一个模块

在 `modules/` 新建 `<模块名>.json`，提交 PR：

```json
{
  "id": "com.example.my-module",
  "name": "My Module",
  "author": { "name": "Your Name", "url": "https://github.com/you" },
  "repo": "you/MyModuleRepo",
  "license": "MIT",
  "summary": "一句话，列表页显示。",
  "description": "详情页正文，支持 markdown。",
  "usage": "装完在哪里启用、要注意什么。",
  "capabilities": ["expression"],
  "defaultRole": "expression",
  "requires": { "abi": 2, "minHostVersion": "0.4.0", "os": ["windows"], "arch": ["x64"] },
  "tags": ["example"],
  "entry": "my-module.dll",
  "icon": "module/icon.svg",
  "iconBranch": "main",
  "tagPrefix": "v",
  "assetPattern": "^my-module-.*\\.zip$",
  "featured": false,
  "verified": false,
  "i18n": { "en": { "summary": "...", "description": "...", "usage": "..." } }
}
```

硬性要求：

- Release tag 是 `v1.2.3` 这种纯 semver（前缀可改 `tagPrefix`）。
- 有一个资产能被 `assetPattern` 匹配，是**打包好的 zip**（含 `fgb-native.json` + DLL）或单个 DLL。
- 仓库公开，`downloadUrl` 是 `https://`。
- **包内 `fgb-native.json` 的 `ModuleId` / `Version` / `DllFileName` / `AbiVersion` 要和清单对得上** ——
  构建时会真的把 zip 解开检查，不一致直接失败。这条是给上架方的保护，别等用户装完才发现。

## 发布

1. 推到 GitHub（默认分支 `main`）。
2. Settings → Pages → Source 选 **GitHub Actions**。
3. 跑一次 `registry` workflow：`dist/` 会提交回来，Pages 同时上线。
4. 要 `registry.yourdomain.com`：Pages 填 Custom domain + DNS CNAME，仍然零成本。

触发方式：每 6 小时定时、`modules/**` 等路径的 push、以及模块仓库发版后打的 `repository_dispatch`：

```yaml
- name: 通知模块库
  env:
    GH_TOKEN: ${{ secrets.REGISTRY_DISPATCH_TOKEN }}   # 只有 fgb-registry 的 contents 权限
  run: gh api repos/Aqamoe/fgb-registry/dispatches -f event_type=module-released
```

## 踩过的坑

**`downloads` 含构建自身的下载。** 算 sha256 要把 zip 拉一次，所以每个版本的数字会被自己抬高 1~2。
有缓存（同一版本只下一次），但别把 `downloads` 当成安装量。

**定时任务不再制造空提交。** 内容没变时沿用上一版 `generatedAt`，产物字节不变，git 自然没 diff。

**Actions 的 cron 有延迟**，`*/6 * * * *` 实际可能晚十几分钟。要准点就用 `repository_dispatch`。

**国内访问**：`*.github.io` 和 `raw.githubusercontent.com` 都不稳。
`https://cdn.jsdelivr.net/gh/Aqamoe/fgb-registry@main/dist/registry.json` 通常更通，
所以 `dist/` 才要提交回仓库。

**包内校验只在真的下载了资产时才做。** 命中 sha256 缓存时跳过 —— 新版本发布那一次一定会查。

**换行符统一 LF**（`.gitattributes`）。不加的话 Windows 上 autocrlf 会让每次改文件都是整文件 diff。

## 安全模型

模块是会被加载进宿主进程的 DLL，这个仓库本质上是**白名单**：

- 只有 review 过的 `modules/*.json` 才会被聚合，谁也不能靠「自己发个 Release」挤进来。
- 每个版本都带 `sha256` + `size`，宿主装前校验。
- 上架时会核对包内 `fgb-native.json` 与清单声明一致，防止挂羊头卖狗肉。
- `verified` 标记区分「审过」与「仅收录」，宿主应对未审核模块给出提示。
- 已知缺口：包内容本身没有签名，作者账号被盗 + 重新发版仍可能投毒。后续可加
  `minisign` 签名或对官方模块做 Authenticode。

## 许可

MIT。模块本身各自的许可证见其仓库。
