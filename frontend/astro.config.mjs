import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  output: "server",
  adapter: vercel({
    edgeMiddleware: false,
    // Allow up to 120s per serverless function execution. The upstream
    // queue worker has been getting progressively slower (40+s already)
    // and could climb further as the queue grows. 2 min gives runway
    // without risking Vercel's hard caps. Other routes that finish in
    // <1s are unaffected.
    maxDuration: 120,
    isr: {
      // Cache static-ish pages at the edge. Mutations only happen when the
      // indexer writes new rows, so 30s freshness is fine for v1.
      // Routes that take query params (?q=, ?p=) are excluded so each
      // filter value renders fresh — the Vercel ISR cache key strips
      // query strings, which would otherwise collapse all filters into
      // one cached response.
      expiration: 30,
      exclude: [
        "/api/feed",
        "/api/search",
        "/api/health",
        "/api/airdrop-check",
        "/api/airdrop-queue.json",
        "/api/airdrop-uptime.json",
        "/assets",
        "/airdrop/queue",
      ],
    },
  }),
  server: {
    port: 4321,
  },
});
