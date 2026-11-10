# 本仓库说明（Fork）

本仓库是 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) **v2.22.0** 的个人修改版，
在原版基础上加了「首页源速览」和「片库」两块功能，其余功能保持原样。

原项目以 **AGPL-3.0-or-later** 授权，本仓库同样遵循 AGPL-3.0（见 [LICENSE](./LICENSE)）。
按 AGPL 要求：分发或通过网络提供本修改版时，必须同样提供完整源代码。

## 新增功能

### 1. 首页「最新上架」+ 源速度榜

- 把所有已勾选的点播源的最新列表**合并成一张海报墙**（不再一个源一行）：
  按源轮流取值（round-robin）保证每个源都有曝光，同名影片按归一化标题去重，
  保留先出现（= 更快）的那个源。
- 顶部一排「速度胶囊」：按本次拉取各源第一页的服务端耗时排序，
  `<800ms` 绿 / `<2000ms` 黄 / 更慢红；点一个源进入该源的片库。
- 相关接口：`POST /api/feed`（多源并行取最新 + 返回耗时，单源失败不影响其它源）。

### 2. 片库 `/library`

- **总库**：所有源按**固定大分类**合并（电视剧 / 短剧 / 电影 / 综艺 / 动漫 / 少儿 / 纪录片 / 知识）。
  源站分类靠关键词归并（国产剧、韩剧、美剧… → 电视剧），
  **短剧单独成类并从电视剧中排除**；每个源每个大分类最多取 2 个 `type_id`，再跨源交错去重。
- **类型（题材）行**：喜剧 / 爱情 / 动作 / … 共 31 个，按源站子分类名匹配（「动作片」→ 动作）。
- **单源库**：切到某个源时按它自己的分类表浏览，支持上一页 / 下一页。
- **地区 / 时间**：源站 API 没有这两个维度，在已加载数据上做二次筛选。
- 相关接口：`POST /api/library`（跨源合并）、`GET /api/catalog`（单源分页）。

## 新增 / 修改的文件

新增：

| 文件 | 说明 |
| --- | --- |
| `src/lib/canonical-categories.ts` | 固定大分类与类型的定义、关键词表 |
| `src/lib/cms-catalog.ts` | Apple CMS 分类/最新列表的取数、解析与缓存 |
| `src/app/api/feed/route.ts` | 首页各源最新 + 耗时 |
| `src/app/api/library/route.ts` | 总库：跨源大分类合并 |
| `src/app/api/catalog/route.ts` | 单源分类分页 |
| `src/app/library/page.tsx` | 片库页 |
| `src/components/source-feed.tsx` | 首页「最新上架」 |
| `src/components/poster-card.tsx` | 竖版海报卡 |

修改：

| 文件 | 改动 |
| --- | --- |
| `src/app/page.tsx` | 首页插入 `SourceFeed` |
| `src/components/header.tsx` | 顶栏「片库」入口（桌面 + 移动端） |
| `src/components/icon.tsx` | 新增 `grid` 图标 |
| `src/lib/client-api.ts` | 新增 `api.feed` / `api.library` / `api.catalog` |
| `src/lib/types.ts` | 新增 `FeedResponse` / `LibraryResponse` / `CatalogResponse` 等类型 |

## 本地开发 / 构建

```bash
pnpm install          # 本项目用 pnpm 构建，pnpm-lock.yaml 为锁文件
pnpm run typecheck
pnpm run build
PASSWORD=your-password PORT=8080 node node_modules/next/dist/bin/next start -p 8080
```

Windows 上不要用 `DOCKER_BUILD=1`（standalone 输出需要创建符号链接，普通用户权限会失败），
直接 `next build` + `next start` 即可。

## 与上游同步

```bash
git remote add upstream https://github.com/LibreSpark/LibreTV.git
git fetch upstream
git merge upstream/main
```

改动集中在上表几个文件，冲突面很小；大分类关键词表在 `src/lib/canonical-categories.ts`，
各源命名差异大时可以只改这一个文件。
