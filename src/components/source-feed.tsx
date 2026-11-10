'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import { cn, validateSourceUrl } from '@/lib/utils';
import type { FeedSourceResult, SearchResultItem } from '@/lib/types';
import { PosterCard } from './poster-card';

/** 速度分档：<800ms 顺畅、<2000ms 一般、更慢标黄 */
function speedTone(ms: number): string {
  if (ms < 800) return 'text-emerald-500';
  if (ms < 2000) return 'text-amber-500';
  return 'text-rose-500';
}

/** 合并后最多展示多少部：再多首屏图片压力大，剩下的去片库看 */
const MERGED_LIMIT = 48;

/**
 * 首页「点播源速览」：
 * 1. 速度榜——这次拉取各源最新列表的服务端耗时，快到慢排序；
 * 2. 最新上架——把所有源的最新列表**合并成一张海报墙**，
 *    按源轮流取（round-robin）保证每个源都有曝光，同名去重，取最快的那个源。
 */
export function SourceFeed({ onOpen }: { onOpen: (item: SearchResultItem) => void }) {
  // 与首页搜索一致的源过滤：无效地址、自动停用、订阅停用都不参与
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const yellowFilter = useAppStore((s) => s.yellowFilter);

  const sources = useMemo(() => {
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

  const query = useQuery({
    queryKey: ['feed', sources.map((s) => s.key), yellowFilter],
    queryFn: ({ signal }) => api.feed(sources, 16, yellowFilter, signal),
    enabled: sources.length > 0,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const results = query.data?.sources ?? [];
  const ranked = useMemo(
    () => results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms),
    [results]
  );
  const failed = results.filter((r) => !r.ok);

  /** 各源轮流取值 + 同名去重：先取每个源的第 1 部，再取第 2 部…… */
  const merged = useMemo(() => mergeFeeds(ranked, MERGED_LIMIT), [ranked]);

  // 没勾选源时不占位：首页下方已有「先添加一个点播源」的引导
  if (sources.length === 0) return null;

  return (
    <section aria-label="点播源速览" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 className="text-sm font-medium text-content">最新上架</h2>
        <span className="text-[11px] text-faint">
          {query.isLoading
            ? '正在汇总各源…'
            : `${ranked.length}/${sources.length} 个源可用 · ${merged.length} 部新片`}
        </span>
        <Link
          href="/library"
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-accent transition-colors hover:bg-hover"
        >
          进入片库 →
        </Link>
      </div>

      {/* 速度榜：紧凑一行，点击跳到片库对应源 */}
      {ranked.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {ranked.map((r, i) => (
            <Link
              key={r.sourceKey}
              href={`/library?source=${encodeURIComponent(r.sourceKey)}`}
              className="flex items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-[11px] transition-colors hover:bg-hover"
              title={`${r.sourceName}：${r.ms}ms，点击进入该源片库`}
            >
              <span className="text-[10px] text-faint">#{i + 1}</span>
              <span className="max-w-[7rem] truncate text-content">{r.sourceName}</span>
              <span className={cn('tabular-nums', speedTone(r.ms))}>{r.ms}ms</span>
            </Link>
          ))}
        </div>
      )}

      {query.isLoading ? (
        <FeedSkeleton />
      ) : query.isError ? (
        <p className="py-6 text-center text-sm text-faint">
          源列表加载失败：{query.error instanceof Error ? query.error.message : '请稍后重试'}
        </p>
      ) : merged.length === 0 ? (
        <p className="py-6 text-center text-sm text-faint">
          暂时取不到各源的最新列表，先去搜索或设置里检查源是否可用。
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {merged.map((item) => (
              <PosterCard
                key={`${item.sourceKey}_${item.vodId}`}
                item={item}
                onClick={() => onOpen(item)}
              />
            ))}
          </div>
          {failed.length > 0 && (
            <p className="mt-3 text-[11px] text-faint">
              {failed.length} 个源暂时取不到最新列表：{failed.map((f) => f.sourceName).join('、')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * 多源合并：按源轮流取一部，避免某个源刷屏；同名（忽略标点空白）只留先出现的那部，
 * 因为 ranked 已按速度排序，先出现的就是更快的源。
 */
function mergeFeeds(ranked: FeedSourceResult[], limit: number): SearchResultItem[] {
  const seen = new Set<string>();
  const out: SearchResultItem[] = [];
  const maxLen = ranked.reduce((m, r) => Math.max(m, r.list.length), 0);

  for (let i = 0; i < maxLen && out.length < limit; i++) {
    for (const r of ranked) {
      const item = r.list[i];
      if (!item || out.length >= limit) continue;
      const key = item.name.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function FeedSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] animate-pulse rounded-lg bg-chip" />
          <div className="mt-1.5 h-3 animate-pulse rounded bg-chip" />
        </div>
      ))}
    </div>
  );
}
