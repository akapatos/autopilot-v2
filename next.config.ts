import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for FFmpeg on Vercel serverless (Node.js, not static export)
  serverExternalPackages: [
    "fluent-ffmpeg",
    "@ffmpeg-installer/ffmpeg",
    "@ffprobe-installer/ffprobe",
    "cloudinary",
  ],
};

export default nextConfig;
