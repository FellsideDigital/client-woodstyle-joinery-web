// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';

export default defineConfig({
  site: 'https://www.woodstylejoinery.co.uk',
  integrations: [sitemap()],
  adapter: node({ mode: 'standalone' }),
  // Behind Railway's proxy, @astrojs/node can't verify X-Forwarded-Host against
  // an allowlist, so Astro's same-origin check misidentifies every real request
  // as cross-site. The /api/contact endpoint is public and unauthenticated
  // (no cookies/sessions), so this check has nothing to protect here.
  security: {
    checkOrigin: false,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
