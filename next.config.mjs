/** @type {import('next').NextConfig} */
const nextConfig = {
  // API route can run the full 4-agent pipeline synchronously.
  // Hobby maxDuration is 300s; Pro allows up to 800s (or 1800s beta).
  experimental: {},
};

export default nextConfig;
