// predict.fun 链接 / slug 解析（bot 命令和 /api/predict-check 共用）

// 从消息文本里找出第一个 predict.fun 链接
export function findPredictUrl(text: string): string | null {
  const m = String(text || '').match(/https?:\/\/(?:www\.)?predict\.fun\/\S+/i);
  return m ? m[0].replace(/[)\]>,，。]+$/, '') : null;
}

// 输入可以是完整链接、路径或裸 slug，返回 slug
export function extractPredictSlug(input: string): string {
  let s = String(input || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    s = u.pathname;
  } catch {
    // 不是 URL：当作路径或裸 slug
  }
  s = s.replace(/^\/(zh-cn|zh|en|ja|ko|es|fr|de|pt|ru)(?=\/)/i, '');
  const m = s.match(/\/(markets?|categories|categor[iy]|events?)\/([^/?#]+)/);
  if (m) return decodeURIComponent(m[2]);
  return decodeURIComponent(s.replace(/^\/+/, '').split(/[/?#]/)[0]);
}
