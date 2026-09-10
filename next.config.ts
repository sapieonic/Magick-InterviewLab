import type { NextConfig } from 'next';

/**
 * Security headers. Note we deliberately do NOT set COOP/COEP (cross-origin
 * isolation): the browser execution engine uses plain Web Workers + Pyodide,
 * neither of which needs SharedArrayBuffer, and COEP would break CDN-loaded
 * Pyodide assets. See README "Architecture decisions".
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@node-rs/argon2'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
