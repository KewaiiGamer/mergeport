import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  compress: true,
  experimental: {
    // Revisiting a page within 30 s (and going back) is instant from the client cache. Actions and live updates still refresh it.
    staleTimes: { dynamic: 30, static: 300 },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          // form-action lists only the two GitHub paths the manifest form posts to (a path source ending in / matches by prefix; the other is exact), not all of github.com
          // The submit is a top-level form navigation; without these the browser blocks it. No other site may receive a form from this app.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self' https://github.com/settings/apps/new https://github.com/organizations/" },
        ],
      },
    ];
  },
};
export default config;
