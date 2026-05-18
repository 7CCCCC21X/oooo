'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
type PairConfig = {
  name: string;
  predictMarketId: string;
  predictSide?: 'Yes' | 'No';
  polymarketConditionId?: string;
  polymarketOutcome?: string;
  polymarketTokenId?: string;
  threshold?: number;
  minSize?: number;
  feeBuffer?: number;
};
type TopBook = {
  bid: { price: number; size: number } | null;
  ask: { price: number; size: number } | null;
  bidDepth: number;
  askDepth: number;
};
type SpreadResult = {
  pair: PairConfig;
  checkedAt: string;
  ok: boolean;
  error?: string;
  predictBook?: TopBook;
  polyBook?: TopBook;
  directionLabel?: string;
  buyPrice?: number;
  sellPrice?: number;
  gap?: number;
  gapCents?: number;
  comparableSize?: number;
  threshold: number;
  minSize: number;
  feeBuffer: number;
  alert: boolean;
};
type SpreadsResponse = {
  ok: boolean;
  checkedAt: string;
  source: string;
  pairs: PairConfig[];
  results: SpreadResult[];
};
type ResolveResponse = {
  ok: boolean;
  error?: string;
  results?: Array<{
    predictMarketId: string;
    predictTitle: string;
    polymarketConditionId: string;
    tokenCount: number;
    tokens: Array<{ outcome: string; tokenId: string }>;
    pairs: PairConfig[];
    mappingNote: string;
  }>;
};
const LOCAL_PAIRS_KEY = 'predict-poly-local-pairs-v1';
const LOCAL_INTERVAL_KEY = 'predict-poly-interval-sec-v1';
function fmt(value: unknown, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'N/A';
}
function cents(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}¢` : 'N/A';
}
function fmtTime(value: string | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
function resultKey(item: SpreadResult) {
  return `${item.pair.predictMarketId}:${item.pair.polymarketTokenId}:${item.directionLabel}:${fmt(item.gap, 4)}`;
}
export default function HomePage() {
  const [data, setData] = useState<SpreadsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const [intervalSec, setIntervalSec] = useState(10);
  const [editorText, setEditorText] = useState('');
  const [useLocalPairs, setUseLocalPairs] = useState(false);
  const [notificationReady, setNotificationReady] = useState(false);
  const [resolveMarketId, setResolveMarketId] = useState('52261');
  const [resolveOutput, setResolveOutput] = useState('');
  const [resolving, setResolving] = useState(false);
  const alertedKeysRef = useRef(new Set<string>());
  useEffect(() => {
    const storedInterval = Number(localStorage.getItem(LOCAL_INTERVAL_KEY) || '10');
    if (Number.isFinite(storedInterval) && storedInterval >= 3) setIntervalSec(storedInterval);
    const storedPairs = localStorage.getItem(LOCAL_PAIRS_KEY);
    if (storedPairs) {
      setEditorText(storedPairs);
      setUseLocalPairs(true);
    }
  }, []);
  const fetchSpreads = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let response: Response;
      if (useLocalPairs) {
        const pairs = JSON.parse(editorText || '[]');
        response = await fetch('/api/spreads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairs })
        });
      } else {
        response = await fetch('/api/spreads', { cache: 'no-store' });
      }
      const json = (await response.json()) as SpreadsResponse & { error?: string };
      if (!response.ok || !json.ok) throw new Error(json.error || `HTTP ${response.status}`);
      setData(json);
      if (!useLocalPairs && !editorText) setEditorText(JSON.stringify(json.pairs || [], null, 2));
      const newAlerts = (json.results || []).filter((item) => item.alert && !alertedKeysRef.current.has(resultKey(item)));
      if (newAlerts.length) {
        newAlerts.forEach((item) => alertedKeysRef.current.add(resultKey(item)));
        if (notificationReady && 'Notification' in window && Notification.permission === 'granted') {
          const first = newAlerts[0];
          new Notification('价差提醒', {
            body: `${first.pair.name}: ${first.directionLabel}，价差 ${cents(first.gapCents)}`
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [editorText, notificationReady, useLocalPairs]);
  useEffect(() => {
    fetchSpreads();
  }, [fetchSpreads]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(fetchSpreads, Math.max(3, intervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, fetchSpreads, intervalSec]);
  const results = useMemo(() => {
    const rows = data?.results || [];
    const filtered = onlyAlerts ? rows.filter((item) => item.alert) : rows;
    return [...filtered].sort((a, b) => Number(b.gap ?? -999) - Number(a.gap ?? -999));
  }, [data, onlyAlerts]);
  const alertCount = data?.results?.filter((item) => item.alert).length || 0;
  const bestGap = data?.results?.reduce<number | null>((best, item) => {
    if (item.gap == null) return best;
    return best == null ? item.gap : Math.max(best, item.gap);
  }, null);
  async function enableNotifications() {
    if (!('Notification' in window)) {
      setError('当前浏览器不支持 Notification API。');
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationReady(permission === 'granted');
  }
  function saveLocalPairs() {
    try {
      JSON.parse(editorText || '[]');
      localStorage.setItem(LOCAL_PAIRS_KEY, editorText);
      setUseLocalPairs(true);
      setError('');
    } catch (err) {
      setError(`pairs JSON 格式错误：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  function useServerPairs() {
    localStorage.removeItem(LOCAL_PAIRS_KEY);
    setUseLocalPairs(false);
    setEditorText('');
    setError('');
  }
  function onIntervalChange(value: string) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 3) {
      setIntervalSec(n);
      localStorage.setItem(LOCAL_INTERVAL_KEY, String(n));
    }
  }
  async function resolveMarket() {
    setResolving(true);
    setError('');
    setResolveOutput('');
    try {
      const response = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ predictMarketId: resolveMarketId })
      });
      const json = (await response.json()) as ResolveResponse;
      if (!response.ok || !json.ok) throw new Error(json.error || `HTTP ${response.status}`);
      const pairs = (json.results || []).flatMap((item) => item.pairs || []);
      setResolveOutput(JSON.stringify({ results: json.results, pairs }, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  }
  function appendResolvedPairs() {
    try {
      const parsed = JSON.parse(resolveOutput || '{}');
      const newPairs: PairConfig[] = parsed.pairs || [];
      if (!Array.isArray(newPairs) || !newPairs.length) throw new Error('resolve 输出里没有 pairs');
      const oldPairs = JSON.parse(editorText || '[]');
      const merged = [...oldPairs, ...newPairs];
      setEditorText(JSON.stringify(merged, null, 2));
      setUseLocalPairs(true);
      localStorage.setItem(LOCAL_PAIRS_KEY, JSON.stringify(merged, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/" className="active">价差监控</Link>
        <Link href="/predict-only">Predict 独有市场</Link>
      </nav>
      <section className="hero">
        <div>
          <p className="eyebrow">Predict.fun × Polymarket</p>
          <h1>价差监控面板</h1>
          <p className="subtitle">
            Predict API Key 只在 Vercel 后端环境变量里使用。网页可以实时轮询；无人值守 Telegram 提醒由 GitHub Actions 或 Vercel Cron 调用 /api/cron。
          </p>
        </div>
        <div className="heroCard">
          <span>当前机会</span>
          <strong>{alertCount}</strong>
          <small>最佳价差：{bestGap == null ? 'N/A' : cents(bestGap * 100)}</small>
        </div>
      </section>
      <section className="controls card">
        <button onClick={fetchSpreads} disabled={loading}>{loading ? '刷新中...' : '立即刷新'}</button>
        <label className="switch"><input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />自动刷新</label>
        <label>间隔秒 <input type="number" min="3" value={intervalSec} onChange={(e) => onIntervalChange(e.target.value)} /></label>
        <label className="switch"><input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} />只看触发</label>
        <button className="secondary" onClick={enableNotifications}>{notificationReady ? '浏览器提醒已开启' : '开启浏览器提醒'}</button>
      </section>
      {error && <div className="error">{error}</div>}
      <section className="summaryGrid">
        <div className="card stat"><span>配置来源</span><strong>{useLocalPairs ? '浏览器本地配置' : data?.source || '服务器配置'}</strong></div>
        <div className="card stat"><span>市场数量</span><strong>{data?.results?.length ?? '-'}</strong></div>
        <div className="card stat"><span>最后检查</span><strong>{fmtTime(data?.checkedAt)}</strong></div>
      </section>
      <section className="card tableCard">
        <div className="sectionHeader">
          <h2>实时价差</h2>
          <p>gap = 卖出价 - 买入价 - feeBuffer。正数达到 threshold 才会触发提醒。</p>
        </div>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>市场</th><th>Predict side</th><th>Polymarket outcome</th><th>Predict bid/ask</th><th>Poly bid/ask</th><th>方向</th><th>价差</th><th>数量</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              {results.map((item) => (
                <tr key={`${item.pair.predictMarketId}-${item.pair.polymarketTokenId}`} className={item.alert ? 'hit' : ''}>
                  <td><b>{item.pair.name}</b><small>Predict #{item.pair.predictMarketId}</small></td>
                  <td>{item.pair.predictSide || 'Yes'}</td>
                  <td>{item.pair.polymarketOutcome || '-'}</td>
                  <td>{fmt(item.predictBook?.bid?.price)} / {fmt(item.predictBook?.ask?.price)}</td>
                  <td>{fmt(item.polyBook?.bid?.price)} / {fmt(item.polyBook?.ask?.price)}</td>
                  <td>{item.directionLabel || '-'}</td>
                  <td className={Number(item.gap || 0) >= 0 ? 'positive' : 'negative'}>{fmt(item.gap)}<small>{cents(item.gapCents)}</small></td>
                  <td>{fmt(item.comparableSize, 2)}</td>
                  <td>{item.ok ? (item.alert ? '🚨 触发' : '正常') : `错误：${item.error}`}</td>
                </tr>
              ))}
              {!results.length && <tr><td colSpan={9} className="empty">暂无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card resolverCard">
        <div className="sectionHeader">
          <h2>市场映射工具</h2>
          <p>输入 Predict marketId，自动读取 polymarketConditionIds 和 token，生成 pairs 配置。</p>
        </div>
        <div className="resolverRow">
          <input value={resolveMarketId} onChange={(e) => setResolveMarketId(e.target.value)} placeholder="Predict marketId，例如 52261" />
          <button onClick={resolveMarket} disabled={resolving}>{resolving ? '映射中...' : '自动映射'}</button>
          <button className="secondary" onClick={appendResolvedPairs} disabled={!resolveOutput}>追加到本地 pairs</button>
        </div>
        <textarea value={resolveOutput} onChange={(e) => setResolveOutput(e.target.value)} spellCheck={false} placeholder="映射结果会显示在这里" />
      </section>
      <section className="card editorCard">
        <div className="sectionHeader">
          <h2>监控配置 pairs</h2>
          <p>可以改 config/pairs.json 后重新部署，也可以在这里临时保存到浏览器 localStorage。</p>
        </div>
        <textarea value={editorText} onChange={(e) => setEditorText(e.target.value)} spellCheck={false} />
        <div className="editorActions">
          <button onClick={saveLocalPairs}>保存并使用本地配置</button>
          <button className="secondary" onClick={useServerPairs}>切回服务器配置</button>
        </div>
      </section>
    </main>
  );
}
