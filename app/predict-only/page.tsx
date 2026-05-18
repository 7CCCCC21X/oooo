'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type PredictMarketSummary = {
  id: string;
  title: string;
  slug?: string;
  categorySlug?: string;
  status?: string;
  tradingStatus?: string;
  isResolved?: boolean;
  closed?: boolean;
  active?: boolean;
  category?: string;
  endDate?: string;
  endMs?: number | null;
  volume?: number;
  liquidity?: number;
  yesPrice?: number | null;
  noPrice?: number | null;
  hourlyRate: number;
  hourlyRateSource?: 'current' | 'schedule' | 'recursive' | 'none';
  spreadThreshold?: number;
  shareThreshold?: number;
  polymarketConditionIds: string[];
  hasPolymarket: boolean;
  tradeable: boolean;
};

type ApiResponse = {
  ok: boolean;
  error?: string;
  checkedAt?: string;
  pagesFetched?: number;
  stoppedReason?: string;
  totalMarkets?: number;
  withPolymarketCount?: number;
  predictOnlyCount?: number;
  predictOnly?: PredictMarketSummary[];
};

type SortKey = 'hourlyRate' | 'volume' | 'liquidity' | 'endMs' | 'title';

function fmtNumber(value: unknown, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (digits === 0) return Math.round(n).toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtPrice(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(1)}¢`;
}

function fmtDate(value?: string | null) {
  if (!value) return '-';
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  return t.toLocaleString('zh-CN', { hour12: false });
}

function fmtRemaining(endMs?: number | null) {
  if (!endMs) return '';
  const ms = endMs - Date.now();
  if (ms <= 0) return '已结束';
  const h = ms / 3600000;
  if (h >= 24) return `${(h / 24).toFixed(1)}d`;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.round(ms / 60000)}m`;
}

function fmtTime(value?: string) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function predictUrl(market: PredictMarketSummary) {
  const slug = market.slug || market.categorySlug;
  if (slug) return `https://predict.fun/market/${slug}`;
  return `https://predict.fun/market/${market.id}`;
}

export default function PredictOnlyPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [hasActiveRewards, setHasActiveRewards] = useState(true);
  const [minHourlyRate, setMinHourlyRate] = useState(0);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('hourlyRate');
  const [sortDesc, setSortDesc] = useState(true);
  const [limit, setLimit] = useState(100);
  const [maxPages, setMaxPages] = useState(50);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (includeClosed) params.set('includeClosed', '1');
      if (hasActiveRewards) params.set('hasActiveRewards', '1');
      if (minHourlyRate > 0) params.set('minHourlyRate', String(minHourlyRate));
      params.set('limit', String(limit));
      params.set('maxPages', String(maxPages));
      const response = await fetch(`/api/predict-only?${params.toString()}`, { cache: 'no-store' });
      const json = (await response.json()) as ApiResponse;
      if (!response.ok || !json.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [includeClosed, hasActiveRewards, minHourlyRate, limit, maxPages]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const rows = useMemo(() => {
    const list = data?.predictOnly || [];
    // 客户端再过滤一遍 tradeable（API 缓存里啥都有）
    const tradeableFiltered = includeClosed ? list : list.filter((m) => m.tradeable);
    const keyword = search.trim().toLowerCase();
    const filtered = keyword
      ? tradeableFiltered.filter(
          (m) =>
            m.title.toLowerCase().includes(keyword) ||
            m.id.includes(keyword) ||
            (m.category || '').toLowerCase().includes(keyword) ||
            (m.categorySlug || '').toLowerCase().includes(keyword)
        )
      : tradeableFiltered;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === 'title') {
        const av = a.title.toLowerCase();
        const bv = b.title.toLowerCase();
        return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
      }
      let av: number;
      let bv: number;
      if (sortKey === 'endMs') {
        av = a.endMs ?? 0;
        bv = b.endMs ?? 0;
      } else {
        av = Number(a[sortKey] ?? 0);
        bv = Number(b[sortKey] ?? 0);
      }
      return sortDesc ? bv - av : av - bv;
    });
    return sorted;
  }, [data, search, sortKey, sortDesc, includeClosed]);

  const openCount = useMemo(() => (data?.predictOnly || []).filter((m) => m.tradeable).length, [data]);
  const closedCount = useMemo(() => (data?.predictOnly || []).filter((m) => !m.tradeable).length, [data]);
  const ppCount = useMemo(() => (data?.predictOnly || []).filter((m) => m.tradeable && m.hourlyRate > 0).length, [data]);

  const totalHourlyRate = useMemo(
    () => (data?.predictOnly || []).filter((m) => m.tradeable).reduce((sum, m) => sum + (Number.isFinite(m.hourlyRate) ? m.hourlyRate : 0), 0),
    [data]
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDesc((v) => !v);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/">价差监控</Link>
        <Link href="/predict-only" className="active">Predict 独有市场</Link>
      </nav>
      <section className="hero">
        <div>
          <p className="eyebrow">Predict-only Markets · PP/h</p>
          <h1>Predict 独有市场</h1>
          <p className="subtitle">
            拉取 predict.fun 上所有市场，过滤掉有 polymarket 映射的（即只剩 predict 独家），并显示每小时 PP 奖励。
            PP/h 提取优先级：<code>rewards.current.hourlyRate</code> → <code>rewards.schedule</code> 当前活跃窗口 → 递归扫描 hourlyRate 字段。
            过期 reward window / 已结束市场会归 0。
          </p>
        </div>
        <div className="heroCard">
          <span>Predict 独有 · 未结束</span>
          <strong>{openCount.toLocaleString()}</strong>
          <small>
            其中在派 PP：{ppCount}（总 PP/h：{fmtNumber(totalHourlyRate, 1)}）<br />
            已结束：{closedCount.toLocaleString()} · 共 {data?.predictOnlyCount ?? '-'}<br />
            全平台总抓取 {data?.totalMarkets ?? '-'}，{data?.withPolymarketCount ?? '-'} 有 polymarket 映射
          </small>
        </div>
      </section>

      <section className="controls card">
        <button onClick={fetchData} disabled={loading}>{loading ? '加载中...' : '刷新'}</button>
        <label className="switch">
          <input type="checkbox" checked={hasActiveRewards} onChange={(e) => setHasActiveRewards(e.target.checked)} />
          仅有奖励的市场 (hasActiveRewards)
        </label>
        <label className="switch">
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
          包含已关闭
        </label>
        <label>
          最小 PP/h
          <input
            type="number"
            min="0"
            step="50"
            value={minHourlyRate}
            onChange={(e) => setMinHourlyRate(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
        <label>
          每页
          <input
            type="number"
            min="10"
            max="500"
            value={limit}
            onChange={(e) => setLimit(Math.max(10, Math.min(500, Number(e.target.value) || 100)))}
          />
        </label>
        <label>
          最多页数
          <input
            type="number"
            min="1"
            max="200"
            value={maxPages}
            onChange={(e) => setMaxPages(Math.max(1, Math.min(200, Number(e.target.value) || 50)))}
          />
        </label>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="summaryGrid">
        <div className="card stat"><span>抓取页数</span><strong>{data?.pagesFetched ?? '-'}</strong></div>
        <div className="card stat"><span>停止原因</span><strong>{data?.stoppedReason || '-'}</strong></div>
        <div className="card stat"><span>最后检查</span><strong>{fmtTime(data?.checkedAt)}</strong></div>
      </section>

      <section className="card tableCard">
        <div className="sectionHeader">
          <h2>独有市场列表</h2>
          <p>表头可点击排序。点市场名跳 predict.fun。</p>
        </div>

        <div className="filterRow">
          <label>搜索 <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="标题、ID、分类..." /></label>
          <span style={{ color: 'var(--muted)' }}>显示 {rows.length} / {data?.predictOnlyCount ?? 0}</span>
        </div>

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('title')}>市场 {sortKey === 'title' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('hourlyRate')}>PP/h {sortKey === 'hourlyRate' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th>Yes</th>
                <th>No</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('volume')}>Volume {sortKey === 'volume' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('liquidity')}>Liquidity {sortKey === 'liquidity' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('endMs')}>End {sortKey === 'endMs' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={m.hourlyRate > 0 ? 'hit' : ''}>
                  <td><code>{m.id}</code></td>
                  <td>
                    <a className="linkOut" href={predictUrl(m)} target="_blank" rel="noreferrer">
                      {m.title || '(无标题)'}
                    </a>
                    {m.category && <small>{m.category}</small>}
                  </td>
                  <td className={m.hourlyRate > 0 ? 'positive' : ''}>
                    <b>{fmtNumber(m.hourlyRate, 1)}</b>
                    {m.hourlyRateSource && m.hourlyRateSource !== 'none' && (
                      <small>{m.hourlyRateSource}</small>
                    )}
                  </td>
                  <td>{fmtPrice(m.yesPrice)}</td>
                  <td>{fmtPrice(m.noPrice)}</td>
                  <td>{fmtNumber(m.volume)}</td>
                  <td>{fmtNumber(m.liquidity)}</td>
                  <td>
                    {fmtDate(m.endDate)}
                    {m.endMs && <small>{fmtRemaining(m.endMs)}</small>}
                  </td>
                  <td>
                    {m.isResolved
                      ? 'resolved'
                      : m.closed
                      ? 'closed'
                      : m.tradingStatus || m.status || (m.tradeable ? 'open' : 'inactive')}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={9} className="empty">{loading ? '加载中...' : '暂无数据'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
