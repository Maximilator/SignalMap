/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
    },
  },
};

module.exports = nextConfig;
