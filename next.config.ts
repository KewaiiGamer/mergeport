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
          // `https://github.com` in form-action: the Team page's "Create the GitHub App" posts GitHub's app manifest to github.com
          // (a top-level form navigation). Without it the browser blocks the submit. No other site may receive a form from this app.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self' https://github.com" },
        ],
      },
    ];
  },
};
export default config;
