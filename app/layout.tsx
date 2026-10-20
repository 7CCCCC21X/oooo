import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Predict.fun 否转换 · Yes 总和看板',
  description: 'NegRisk Yes best-bid sums, PP/h markets and pipeline status for predict.fun.'
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
