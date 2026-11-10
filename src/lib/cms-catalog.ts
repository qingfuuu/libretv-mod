import { cmsRequestHeaders, isAdultContent, parseSearchList } from './cms-parser';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import type { CatalogCategory, SearchResultItem, SourceConfig } from './types';

/**
 * Apple CMS 分类浏览（片库 / 各源最新）的服务端取数与解析。
 *
 * 采集站的标准能力：
 * - `?ac=videolist&pg=1` 不带关键词 → 按入库时间倒序的最新列表（首页「各源最新」）；
 * - `?ac=videolist&t=<type_id>&pg=N` → 按分类分页浏览（片库）；
 * - 响应里的 `class` 数组是源站分类表（type_id / type_name），
 *   个别源只在 `?ac=list` 里返回，因此拿不到时补一次轻量请求。
 */

/** 分类浏览单页结果 */
export interface CatalogPage {
  list: SearchResultItem[];
  page: number;
  pageCount: number;
  total: number;
  categories: CatalogCategory[];
}

const CATALOG_CACHE_TTL = 5 * 60 * 1000;
/** 分类表变化很慢：单独缓存 6 小时，避免每次翻页都重复拉 */
const CATEGORY_CACHE_TTL = 6 * 60 * 60 * 1000;

/** 解析 `class` 数组为统一分类结构（源站字段可能是数字或字符串，一律转字符串） */
export function parseCategories(data: unknown): CatalogCategory[] {
  const cls = (data as { class?: unknown } | null)?.class;
  if (!Array.isArray(cls)) return [];
  const seen = new Set<string>();
  const out: CatalogCategory[] = [];
  for (const raw of cls) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const id = String(c.type_id ?? '').trim();
    const name = String(c.type_name ?? '').trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out;
}

/** pagecount / total 可能是字符串或数字，非法时回退 */
function toInt(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 取某个源的一页分类列表。
 * `type` 为空表示「全部」（源站默认按最新排序），`page` 从 1 开始。
 * 结果按「源 + 分类 + 页」缓存 5 分钟：翻页来回切换不会反复打源站。
 */
export async function fetchCatalogPage(
  source: SourceConfig,
  opts: { type?: string; page?: number; filterAdult?: boolean; timeoutMs?: number } = {}
): Promise<CatalogPage> {
  const type = (opts.type || '').trim();
  const page = Math.max(1, opts.page || 1);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const cacheKey = `catalog:${source.url.replace(/\/+$/, '')}:${type}:${page}`;

  let pageData = getCache<Omit<CatalogPage, 'list'>>(cacheKey + ':meta');
  let cachedList = getCache<SearchResultItem[]>(cacheKey + ':list');

  if (!pageData || !cachedList) {
    const base = source.url.replace(/\/+$/, '');
    const params = new URLSearchParams({ ac: 'videolist', pg: String(page) });
    if (type) params.set('t', type);
    const res = await fetchUpstream(`${base}?${params.toString()}`, {
      timeoutMs,
      headers: cmsRequestHeaders(),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;

    cachedList = parseSearchList(data, source);
    let categories = parseCategories(data);
    if (categories.length === 0) categories = await getSourceCategories(source, timeoutMs);

    pageData = {
      page,
      // 源站没给 pagecount 时退化为 1 页，避免「下一页」一直点得动却是空的
      pageCount: Math.max(1, toInt((data as { pagecount?: unknown })?.pagecount, 1)),
      total: toInt((data as { total?: unknown })?.total, cachedList.length),
      categories,
    };
    setCache(cacheKey + ':meta', pageData, CATALOG_CACHE_TTL);
    setCache(cacheKey + ':list', cachedList, CATALOG_CACHE_TTL);
  }

  const list =
    opts.filterAdult === false ? cachedList : cachedList.filter((item) => !isAdultContent(item.typeName));
  return { ...pageData, list };
}

/** 分类表：部分源的 ac=videolist 不返回 class，补一次 ac=list。导出给「合并片库」取跨源分类并集用。 */
export async function getSourceCategories(source: SourceConfig, timeoutMs = 8000): Promise<CatalogCategory[]> {
  const key = `catalog-class:${source.url.replace(/\/+$/, '')}`;
  const cached = getCache<CatalogCategory[]>(key);
  if (cached) return cached;
  try {
    const base = source.url.replace(/\/+$/, '');
    const res = await fetchUpstream(`${base}?ac=list`, { timeoutMs, headers: cmsRequestHeaders() });
    if (!res.ok) return [];
    const categories = parseCategories(await res.json());
    if (categories.length > 0) setCache(key, categories, CATEGORY_CACHE_TTL);
    return categories;
  } catch {
    return [];
  }
}
