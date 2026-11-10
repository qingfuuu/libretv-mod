'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Header } from '@/components/header';
import { DetailModal } from '@/components/detail-modal';
import { PosterCard } from '@/components/poster-card';
import { EmptyState } from '@/components/states';
import { SiteFooter } from '@/components/site-footer';
import { api } from '@/lib/client-api';
import { CANONICAL_CATEGORIES, GENRES } from '@/lib/canonical-categories';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import { cn, validateSourceUrl } from '@/lib/utils';
import type { SearchResultItem, SourceConfig } from '@/lib/types';

/**
 * 片库：
 * - 「总库」把所有源的同一分类合并展示（跨源去重）；
 * - 也可以切到单个源，按那个源自己的分类表分页浏览。
 * 地区/年份源站 API 不支持，统一在已加载的数据上二次筛选。
 */
export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryContent />
    </Suspense>
  );
}

/** 与首页一致的可用源（有效地址、未停用、订阅未停用） */
function useAvailableSources(): SourceConfig[] {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  return useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        return true;
      })
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions]);
}

/** 地区名归一：各源写法不一（大陆/内地/中国大陆），合并成同一档 */
function normalizeArea(area?: string): string | undefined {
  const a = (area || '').trim();
  if (!a) return undefined;
  if (a === '大陆' || a === '中国大陆' || a === '内地') return '内地';
  if (a === '香港' || a === '中国香港') return '中国香港';
  if (a === '台湾' || a === '中国台湾') return '中国台湾';
  return a;
}

/** 取出现次数最多的若干取值（按次数降序，同次数按名称） */
function topValues(values: (string | undefined)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, limit)
    .map(([v]) => v);
}

/** 同名去重（忽略空白标点与大小写） */
function dedupeByName(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  for (const item of items) {
    const key = item.name.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function LibraryContent() {
  const sources = useAvailableSources();
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const searchParams = useSearchParams();

  /** 'all' = 总库，其它值 = 某个源的 key（首页「查看全部 →」用 ?source= 直接打开该源） */
  const [scope, setScope] = useState<string>(searchParams.get('source') || 'all');
  /** 总库模式存固定大分类名，单源模式存该源的 type_id */
  const [category, setCategory] = useState('');
  /** 类型/题材（仅总库模式）：动作 / 喜剧 … */
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [area, setArea] = useState('');
  const [year, setYear] = useState('');
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);

  const sourceKeys = sources.map((s) => s.key);
  const activeSource = scope === 'all' ? null : sources.find((s) => s.key === scope) ?? null;

  // URL 带来的源已不存在（删除/未勾选）时退回总库，避免停在一个永远空白的库
  useEffect(() => {
    if (scope === 'all' || sources.length === 0) return;
    if (!sources.some((s) => s.key === scope)) setScope('all');
  }, [sources, scope]);

  // 总库：按固定大分类跨源合并，向下累积
  const mergedQuery = useInfiniteQuery({
    queryKey: ['library', 'all', sourceKeys, category, genre, yellowFilter],
    queryFn: ({ pageParam, signal }) =>
      api.library(sources, category || undefined, genre || undefined, pageParam as number, yellowFilter, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    enabled: scope === 'all' && sources.length > 0,
    staleTime: 2 * 60 * 1000,
  });

  // 单源：按该源自己的分类分页
  const sourceQuery = useQuery({
    queryKey: ['catalog', activeSource?.url, category, page, yellowFilter],
    queryFn: ({ signal }) =>
      api.catalog(activeSource as SourceConfig, category || undefined, page, yellowFilter, signal),
    enabled: Boolean(activeSource),
    staleTime: 2 * 60 * 1000,
  });

  const items = useMemo(() => {
    if (scope === 'all') {
      return dedupeByName((mergedQuery.data?.pages ?? []).flatMap((p) => p.items));
    }
    return dedupeByName(sourceQuery.data?.list ?? []);
  }, [scope, mergedQuery.data, sourceQuery.data]);

  /** 分类标签：总库用固定的八个大类，单源用该源自己的分类表 */
  const categoryOptions = useMemo(() => {
    if (scope === 'all') {
      return CANONICAL_CATEGORIES.map((c) => ({ id: c.name, name: c.name }));
    }
    return (sourceQuery.data?.categories ?? []).map((c) => ({ id: c.id, name: c.name }));
  }, [scope, sourceQuery.data]);

  const loading = scope === 'all' ? mergedQuery.isLoading : sourceQuery.isLoading;
  const error = scope === 'all' ? mergedQuery.error : sourceQuery.error;
  const isError = scope === 'all' ? mergedQuery.isError : sourceQuery.isError;

  const areaOptions = useMemo(() => topValues(items.map((i) => normalizeArea(i.area)), 12), [items]);
  const yearOptions = useMemo(() => {
    const years = topValues(
      items.map((i) => (/^\d{4}$/.test(i.year || '') ? i.year : undefined)),
      12
    );
    return years.sort((a, b) => Number(b) - Number(a));
  }, [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (i) => (!area || normalizeArea(i.area) === area) && (!year || i.year === year)
      ),
    [items, area, year]
  );

  const scopeLabel = scope === 'all' ? '总库' : activeSource?.name ?? '';

  const switchScope = (next: string) => {
    if (next === scope) return;
    setScope(next);
    setCategory('');
    setGenre('');
    setPage(1);
    setArea('');
    setYear('');
  };

  const switchCategory = (id: string) => {
    if (id === category) return;
    setCategory(id);
    setGenre('');
    setPage(1);
    setArea('');
    setYear('');
  };

  const switchGenre = (g: string) => {
    setGenre((prev) => (prev === g ? '' : g));
    setPage(1);
    setArea('');
    setYear('');
  };

  const filtering = Boolean(area || year);

  return (
    <div className="flex min-h-screen flex-col">
      <Header showSearch />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-content">片库</h1>
          <p className="text-xs text-faint">
            {scope === 'all' ? '所有点播源合并浏览' : `来源：${scopeLabel}`}
            {!loading && ` · 已加载 ${items.length} 部`}
            {filtering && ` · 筛选出 ${filtered.length} 部`}
          </p>
        </div>

        {sources.length === 0 ? (
          <EmptyState
            icon="search"
            title="还没有可用的点播源"
            description="先在「设置 → 源管理」里添加并勾选点播源，片库才会有内容。"
            className="!py-16"
          />
        ) : (
          <>
            {/* 库切换：总库 + 每个源 */}
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => switchScope('all')}
                className={cn(
                  'rounded-full px-3 py-1 text-xs transition-colors',
                  scope === 'all'
                    ? 'bg-accent text-on-accent'
                    : 'bg-chip text-muted hover:bg-hover hover:text-content'
                )}
              >
                总库（全部源）
              </button>
              {sources.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => switchScope(s.key)}
                  className={cn(
                    'max-w-[10rem] truncate rounded-full px-3 py-1 text-xs transition-colors',
                    s.key === scope
                      ? 'bg-accent text-on-accent'
                      : 'bg-chip text-muted hover:bg-hover hover:text-content'
                  )}
                  title={s.name}
                >
                  {s.name}
                </button>
              ))}
            </div>

            {/* 大类 */}
            <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5 border-b border-line pb-2.5">
              <CategoryTab active={category === ''} onClick={() => switchCategory('')}>
                全部
              </CategoryTab>
              {categoryOptions.map((c) => (
                <CategoryTab key={c.id} active={category === c.id} onClick={() => switchCategory(c.id)}>
                  {c.name}
                </CategoryTab>
              ))}
            </div>

            {/* 类型（题材）：仅总库模式，源站按「动作片/喜剧片」这类子分类落库 */}
            {scope === 'all' && (
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <span className="rounded bg-chip px-2 py-0.5 text-muted">类型</span>
                <button
                  type="button"
                  onClick={() => switchGenre('')}
                  className={cn(
                    'transition-colors',
                    genre === '' ? 'text-accent' : 'text-muted hover:text-content'
                  )}
                >
                  全部
                </button>
                {GENRES.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => switchGenre(g)}
                    className={cn(
                      'transition-colors',
                      g === genre ? 'text-accent' : 'text-muted hover:text-content'
                    )}
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}

            {areaOptions.length > 1 && (
              <FilterRow label="地区" options={areaOptions} value={area} onChange={setArea} />
            )}            {yearOptions.length > 1 && (
              <FilterRow label="时间" options={yearOptions} value={year} onChange={setYear} />
            )}

            {isError ? (
              <p className="py-12 text-center text-sm text-faint">
                片库加载失败：{error instanceof Error ? error.message : '请稍后重试'}
              </p>
            ) : loading ? (
              <GridSkeleton />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon="search"
                title={filtering ? '没有符合筛选条件的内容' : '这个分类下暂时没有内容'}
                description={
                  filtering
                    ? '地区/年份是在已加载的内容里筛选的，先「加载更多」或换个条件试试。'
                    : '换一个分类，或稍后「加载更多」看看。'
                }
                className="!py-16"
              />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
                  {filtered.map((item) => (
                    <PosterCard
                      key={`${item.sourceKey}_${item.vodId}`}
                      item={item}
                      onClick={() => setDetailItem(item)}
                    />
                  ))}
                </div>

                {/* 总库 = 向下累积；单源 = 逐页翻 */}
                {scope === 'all' ? (
                  mergedQuery.hasNextPage && (
                    <div className="mt-6 flex justify-center">
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        disabled={mergedQuery.isFetchingNextPage}
                        onClick={() => mergedQuery.fetchNextPage()}
                      >
                        {mergedQuery.isFetchingNextPage
                          ? '加载中…'
                          : filtering
                            ? '加载更多（扩大筛选范围）'
                            : '加载更多'}
                      </button>
                    </div>
                  )
                ) : (
                  <div className="mt-6 flex items-center justify-center gap-3">
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      disabled={page <= 1 || sourceQuery.isFetching}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                    >
                      上一页
                    </button>
                    <span className="text-xs tabular-nums text-muted">
                      第 {page} / {Math.max(1, sourceQuery.data?.pageCount ?? 1)} 页
                    </span>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      disabled={page >= (sourceQuery.data?.pageCount ?? 1) || sourceQuery.isFetching}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>

      <SiteFooter />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function CategoryTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative pb-1 text-sm transition-colors',
        active ? 'font-medium text-content' : 'text-muted hover:text-content'
      )}
    >
      {children}
      {active && <span className="absolute inset-x-0 -bottom-2.5 h-0.5 rounded bg-accent" />}
    </button>
  );
}

/** 一行筛选：左侧灰底标签 + 右侧可点取值，空值表示「不限」 */
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="rounded bg-chip px-2 py-0.5 text-muted">{label}</span>
      <button
        type="button"
        onClick={() => onChange('')}
        className={cn('transition-colors', value === '' ? 'text-accent' : 'text-muted hover:text-content')}
      >
        全部
      </button>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt === value ? '' : opt)}
          className={cn(
            'transition-colors',
            opt === value ? 'text-accent' : 'text-muted hover:text-content'
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
      {Array.from({ length: 24 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] animate-pulse rounded-lg bg-chip" />
          <div className="mt-1.5 h-3 animate-pulse rounded bg-chip" />
        </div>
      ))}
    </div>
  );
}
