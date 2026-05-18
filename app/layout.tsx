import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Predict.fun × Polymarket 价差监控',
  description: 'Monitor Predict.fun and Polymarket top-of-book spreads.'
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
