'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type PredictMarketSummary = {
  id: string;
  title: string;
  slug?: string;
  status?: string;
  closed?: boolean;
  active?: boolean;
  category?: string;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  yesPrice?: number | null;
  noPrice?: number | null;
  polymarketConditionIds: string[];
  hasPolymarket: boolean;
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

type SortKey = 'volume' | 'liquidity' | 'endDate' | 'title';

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

function fmtDate(value?: string) {
  if (!value) return '-';
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return value;
  return t.toLocaleDateString('zh-CN');
}

function fmtTime(value?: string) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function predictUrl(market: PredictMarketSummary) {
  if (market.slug) return `https://predict.fun/markets/${market.slug}`;
  return `https://predict.fun/markets/${market.id}`;
}

export default function PredictOnlyPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('volume');
  const [sortDesc, setSortDesc] = useState(true);
  const [limit, setLimit] = useState(100);
  const [maxPages, setMaxPages] = useState(50);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (includeClosed) params.set('includeClosed', '1');
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
  }, [includeClosed, limit, maxPages]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const rows = useMemo(() => {
    const list = data?.predictOnly || [];
    const keyword = search.trim().toLowerCase();
    const filtered = keyword
      ? list.filter((m) => m.title.toLowerCase().includes(keyword) || m.id.includes(keyword) || (m.category || '').toLowerCase().includes(keyword))
      : list;
    const sorted = [...filtered].sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      if (sortKey === 'title') {
        av = a.title.toLowerCase();
        bv = b.title.toLowerCase();
        return sortDesc ? bv.toString().localeCompare(av.toString()) : av.toString().localeCompare(bv.toString());
      }
      if (sortKey === 'endDate') {
        av = a.endDate ? new Date(a.endDate).getTime() : 0;
        bv = b.endDate ? new Date(b.endDate).getTime() : 0;
      } else {
        av = Number(a[sortKey] ?? 0);
        bv = Number(b[sortKey] ?? 0);
      }
      const an = Number(av);
      const bn = Number(bv);
      return sortDesc ? bn - an : an - bn;
    });
    return sorted;
  }, [data, search, sortKey, sortDesc]);

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
          <p className="eyebrow">Predict-only Markets</p>
          <h1>Predict 独有市场</h1>
          <p className="subtitle">
            拉取 predict.fun 上所有市场，过滤出没有对应 polymarket 映射（polymarketConditionIds 为空）的市场。这些是 predict.fun 独家的，没有跨平台对冲机会，但可能是你想关注的独特标的。
          </p>
        </div>
        <div className="heroCard">
          <span>Predict 独有数量</span>
          <strong>{data?.predictOnlyCount ?? '-'}</strong>
          <small>总计 {data?.totalMarkets ?? '-'}，其中 {data?.withPolymarketCount ?? '-'} 个有 polymarket 映射</small>
        </div>
      </section>

      <section className="controls card">
        <button onClick={fetchData} disabled={loading}>{loading ? '加载中...' : '刷新'}</button>
        <label className="switch">
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
          包含已关闭市场
        </label>
        <label>每页 <input type="number" min="10" max="500" value={limit} onChange={(e) => setLimit(Math.max(10, Math.min(500, Number(e.target.value) || 100)))} /></label>
        <label>最多页数 <input type="number" min="1" max="200" value={maxPages} onChange={(e) => setMaxPages(Math.max(1, Math.min(200, Number(e.target.value) || 50)))} /></label>
      </section>

      {error && <div className="error">{error}</div>}

      <section className="summaryGrid">
        <div className="card stat">
          <span>抓取页数</span>
          <strong>{data?.pagesFetched ?? '-'}</strong>
        </div>
        <div className="card stat">
          <span>停止原因</span>
          <strong>{data?.stoppedReason || '-'}</strong>
        </div>
        <div className="card stat">
          <span>最后检查</span>
          <strong>{fmtTime(data?.checkedAt)}</strong>
        </div>
      </section>

      <section className="card tableCard">
        <div className="sectionHeader">
          <h2>独有市场列表</h2>
          <p>表头可点击排序。Yes/No 价格来自市场列表接口（未必是 orderbook top）。</p>
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
                <th>分类</th>
                <th>Yes</th>
                <th>No</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('volume')}>Volume {sortKey === 'volume' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('liquidity')}>Liquidity {sortKey === 'liquidity' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('endDate')}>End {sortKey === 'endDate' ? (sortDesc ? '↓' : '↑') : ''}</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><code>{m.id}</code></td>
                  <td>
                    <a className="linkOut" href={predictUrl(m)} target="_blank" rel="noreferrer">{m.title || '(无标题)'}</a>
                    <span className="badge">predict-only</span>
                  </td>
                  <td>{m.category || '-'}</td>
                  <td>{fmtPrice(m.yesPrice)}</td>
                  <td>{fmtPrice(m.noPrice)}</td>
                  <td>{fmtNumber(m.volume)}</td>
                  <td>{fmtNumber(m.liquidity)}</td>
                  <td>{fmtDate(m.endDate)}</td>
                  <td>{m.closed ? 'closed' : m.status || (m.active === false ? 'inactive' : 'open')}</td>
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
