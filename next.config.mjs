/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async redirects() {
    // 看板已经是首页；旧链接 /dashboard 直接转到 /
    return [{ source: '/dashboard', destination: '/', permanent: false }];
  }
};
export default nextConfig;
