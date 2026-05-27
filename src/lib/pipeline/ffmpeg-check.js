import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  ffmpeg,
  ffmpegInstaller,
  ffprobeInstaller,
} from "@/lib/pipeline/ffmpeg-config";
import { getErrorMessage } from "@/lib/pipeline/error-message";

const execFileAsync = promisify(execFile);

let cachedStatus = null;

function formatExecError(error) {
  const base = getErrorMessage(error);
  if (!(error instanceof Error)) {
    return base;
  }
  const parts = [base];
  if ("code" in error && error.code != null) {
    parts.push(`code=${error.code}`);
  }
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    parts.push(error.stderr.trim());
  }
  return parts.join(" | ");
}

async function probeFfmpegBinary(binaryPath) {
  await fs.access(binaryPath);
  const { stdout } = await execFileAsync(binaryPath, ["-version"], {
    timeout: 15000,
    maxBuffer: 1024 * 512,
  });
  const versionLine = stdout.split("\n")[0]?.trim() ?? "unknown";
  return { path: binaryPath, versionLine };
}

/**
 * Detect whether FFmpeg can run in this environment (local vs Vercel serverless).
 * Caches result for the lifetime of the process.
 */
export async function checkFfmpegAvailability({ force = false } = {}) {
  if (cachedStatus && !force) {
    return cachedStatus;
  }

  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegInstaller?.path,
    "ffmpeg",
  ].filter(Boolean);

  const status = {
    available: false,
    workingPath: null,
    versionLine: null,
    vercel: Boolean(process.env.VERCEL),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    installerPath: ffmpegInstaller?.path ?? null,
    envFfmpegPath: process.env.FFMPEG_PATH ?? null,
    candidates,
    probeErrors: [],
    probedAt: new Date().toISOString(),
  };

  console.log("[ffmpeg-check] Probing FFmpeg availability", {
    vercel: status.vercel,
    candidates: status.candidates,
    installerPath: status.installerPath,
  });

  for (const candidate of candidates) {
    try {
      const probe = await probeFfmpegBinary(candidate);
      status.available = true;
      status.workingPath = probe.path;
      status.versionLine = probe.versionLine;
      ffmpeg.setFfmpegPath(probe.path);
      ffmpeg.setFfprobePath(ffprobeInstaller.path);

      console.log("[ffmpeg-check] FFmpeg is available", {
        path: probe.path,
        ffprobePath: ffprobeInstaller.path,
        version: probe.versionLine,
      });

      cachedStatus = status;
      return status;
    } catch (error) {
      const message = formatExecError(error);
      status.probeErrors.push({ path: candidate, message });
      console.warn("[ffmpeg-check] FFmpeg probe failed", {
        path: candidate,
        message,
      });
    }
  }

  console.error("[ffmpeg-check] FFmpeg not available — Cloudinary fallbacks will be used", {
    vercel: status.vercel,
    probeErrors: status.probeErrors,
  });

  cachedStatus = status;
  return status;
}

export function isFfmpegAvailable(status) {
  return Boolean(status?.available);
}

/** Configure fluent-ffmpeg before running commands; throws if unavailable. */
export async function ensureFfmpegConfigured() {
  const status = await checkFfmpegAvailability();
  if (!status.available) {
    const detail = status.probeErrors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(
      `FFmpeg is not available in this environment (${detail || "no candidates"})`,
    );
  }
  return status;
}

export function logFfmpegError(phase, error, extra = {}) {
  const payload = {
    phase,
    message: getErrorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...extra,
  };
  console.error("[ffmpeg]", payload);
  return payload;
}
