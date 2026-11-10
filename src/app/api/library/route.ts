import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchCatalogPage, getSourceCategories } from '@/lib/cms-catalog';
import { CANONICAL_CATEGORIES, normalizeCategoryName } from '@/lib/canonical-categories';
import type { CatalogCategory, LibraryResponse, SearchResultItem, SourceConfig } from '@/lib/types';

export const runtime = 'nodejs';

const MAX_SOURCES = 12;
const SOURCE_TIMEOUT_MS = 8000;
/** 每个源、每个大分类最多取几个 type_id（如「电视剧」可能同时对应 国产剧 + 韩剧） */
const MAX_TYPE_PER_SOURCE = 2;
/** 一页合并上限 */
const MAX_PER_PAGE = 60;

interface LibraryBody {
  sources: SourceConfig[];
  /** 固定大分类名（电视剧 / 短剧 / 电影 …），空表示全部 */
  category?: string;
  /** 类型/题材（动作 / 喜剧 …），空表示不限 */
  genre?: string;
  page?: number;
  filterAdult?: boolean;
}

/**
 * 合并片库：把所有源按**固定大分类**（电视剧/短剧/电影/综艺/动漫/少儿/纪录片/知识）
 * 归并后一起取，而不是「一个源一个库」。
 *
 * 分类在源站是真实可过滤的（`t=<type_id>`），这里按关键词把源站分类映射到大分类：
 * - 命中大分类关键词 → 计入；命中排除词（如短剧）→ 跳过；
 * - 每个源最多取 MAX_TYPE_PER_SOURCE 个 type_id（覆盖「国产剧/韩剧」这类拆分）；
 * - 再按源、按分类轮流交错合并 + 同名去重。
 *
 * 地区/年份源站不支持过滤，由前端在已加载数据上二次筛选。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  let body: LibraryBody;
  try {
    body = (await req.json()) as LibraryBody;
  } catch {
    return NextResponse.json({ error: '请求格式错误' }, { status: 400 });
  }

  const sources = (Array.isArray(body.sources) ? body.sources : [])
    .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
    .slice(0, MAX_SOURCES);
  if (sources.length === 0) {
    return NextResponse.json({ error: '请至少选择一个点播源' }, { status: 400 });
  }

  const rawPage = Number(body.page);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(Math.floor(rawPage), 200) : 1;
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const genre = typeof body.genre === 'string' ? body.genre.trim() : '';
  const filterAdult = body.filterAdult !== false;

  // 1. 各源分类表（服务端缓存 6h）
  const perSource = await Promise.all(
    sources.map(async (source) => ({
      source,
      categories: await getSourceCategories(source, SOURCE_TIMEOUT_MS),
    }))
  );

  // 2. 映射到 type_id；选了大分类/类型但没有对应分类的源本轮跳过
  const targets = perSource
    .map(({ source, categories }) => ({
      source,
      typeIds: pickTypeIds(categories, category, genre),
    }))
    .filter((t) => (!category && !genre) || t.typeIds.length > 0);

  if (targets.length === 0) {
    const empty: LibraryResponse = { items: [], page, hasMore: false, categories: [] };
    return NextResponse.json(empty);
  }

  // 3. 并行取每个源（及其多个 type_id）这一页
  const perSourceLists = await Promise.all(
    targets.map(async ({ source, typeIds }) => {
      const ids: (string | undefined)[] = typeIds.length > 0 ? typeIds : [undefined];
      const pages = await Promise.all(
        ids.map(async (typeId) => {
          try {
            return await fetchCatalogPage(source, {
              type: typeId,
              page,
              filterAdult,
              timeoutMs: SOURCE_TIMEOUT_MS,
            });
          } catch {
            return null;
          }
        })
      );
      const ok = pages.filter((p): p is NonNullable<typeof p> => p !== null);
      if (ok.length === 0) return null;
      return {
        list: interleave(ok.map((p) => p.list)),
        pageCount: Math.max(...ok.map((p) => p.pageCount)),
      };
    })
  );

  // 4. 跨源交错合并 + 同名去重
  const ok = perSourceLists.filter((r): r is NonNullable<typeof r> => r !== null);
  const seen = new Set<string>();
  const items: SearchResultItem[] = [];
  const maxLen = ok.reduce((m, r) => Math.max(m, r.list.length), 0);
  for (let i = 0; i < maxLen && items.length < MAX_PER_PAGE; i++) {
    for (const r of ok) {
      const item = r.list[i];
      if (!item || items.length >= MAX_PER_PAGE) continue;
      const key = normalizeCategoryName(item.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  const response: LibraryResponse = {
    items,
    page,
    hasMore: ok.some((r) => r.pageCount > page) && items.length > 0,
    categories: [],
  };
  return NextResponse.json(response);
}

/** 多个列表轮流取一条（不在这里去重，交给外层统一做） */
function interleave(lists: SearchResultItem[][]): SearchResultItem[] {
  const out: SearchResultItem[] = [];
  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const l of lists) {
      const item = l[i];
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * 按大分类/类型挑选源站的 type_id。
 *
 * 优先级：类型（genre）匹配 > 大分类精确命中 > 大分类关键词命中；
 * 大分类的排除词（短剧）对所有候选生效——这就是「短剧不混进电视剧」的落点。
 */
function pickTypeIds(
  categories: CatalogCategory[],
  category: string,
  genre: string,
  limit = MAX_TYPE_PER_SOURCE
): string[] {
  const wanted = category ? CANONICAL_CATEGORIES.find((c) => c.name === category) : undefined;
  if (!wanted && !genre) return [];

  const scored: { id: string; score: number }[] = [];
  for (const c of categories) {
    const name = normalizeCategoryName(c.name);
    if (!name) continue;

    // 短剧等排除词优先判断：任何大分类下都不该把短剧混进来
    if (wanted?.exclude?.some((k) => name.includes(normalizeCategoryName(k)))) continue;

    let score = 0;
    if (genre) {
      // 选了类型时只看类型匹配（「动作」命中「动作片」），避免电影大类抢占
      if (name.includes(normalizeCategoryName(genre))) score = 60;
    } else if (wanted) {
      const exact = name === normalizeCategoryName(wanted.name);
      const hit = wanted.match.some((k) => name.includes(normalizeCategoryName(k)));
      if (exact) score = 100;
      else if (hit) score = 50;
    }
    if (score > 0) scored.push({ id: c.id, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id);
}
