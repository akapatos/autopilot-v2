import fs from "fs/promises";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import {
  ensureFfmpegConfigured,
  logFfmpegError,
} from "@/lib/pipeline/ffmpeg-check";
import { probeMediaDuration } from "@/lib/pipeline/ffmpeg-prepare";

async function downloadToFile(url, destPath, label) {
  console.log("[ffmpeg-scene] Downloading", { label, url: url?.slice?.(0, 120), destPath });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${label}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destPath, buffer);

  const stat = await fs.stat(destPath);
  console.log("[ffmpeg-scene] Download complete", {
    label,
    bytes: stat.size,
    destPath,
  });

  return stat.size;
}

/**
 * Trim/loop stock video to target duration, scale to 1080p, mux voiceover audio.
 */
function runFfmpegSceneMux(
  stockPath,
  voicePath,
  outputPath,
  targetDuration,
  sourceDuration,
  trimStart,
) {
  return new Promise((resolve, reject) => {
    const availableDuration = Math.max(0.1, sourceDuration - trimStart);
    const needsLoop = targetDuration > availableDuration + 0.05;
    const streamLoop = needsLoop
      ? Math.max(0, Math.ceil(targetDuration / availableDuration) - 1)
      : 0;

    console.log("[ffmpeg-scene] Muxing stock + voice", {
      stockPath,
      voicePath,
      outputPath,
      targetDuration,
      sourceDuration,
      trimStart,
      needsLoop,
      streamLoop,
    });

    const inputOptions = ["-ss", String(trimStart)];
    let command = ffmpeg();

    if (needsLoop) {
      command = command
        .input(stockPath)
        .inputOptions([...inputOptions, "-stream_loop", String(streamLoop)]);
    } else {
      command = command.input(stockPath).inputOptions(inputOptions);
    }

    command
      .input(voicePath)
      .duration(targetDuration)
      .videoFilters(
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
      )
      .outputOptions([
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-crf",
        "28",
        "-preset",
        "fast",
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-shortest",
        "-movflags",
        "+faststart",
      ])
      .output(outputPath)
      .on("end", () => {
        console.log("[ffmpeg-scene] Scene mux complete", { outputPath });
        resolve();
      })
      .on("error", (err) => {
        logFfmpegError("scene-mux", err, { stockPath, voicePath, outputPath });
        reject(err);
      })
      .run();
  });
}

/**
 * Download stock + voice, build finished scene MP4 locally (no Cloudinary transforms).
 */
export async function buildSceneSegmentWithFfmpeg({
  stockUrl,
  voiceUrl,
  trimStart: trimStartSeconds = 0,
  targetDuration: targetDurationSeconds,
}) {
  await ensureFfmpegConfigured();

  const targetDuration = Math.max(0.1, Number(targetDurationSeconds) || 10);
  const trimStart = Math.max(0, Number(trimStartSeconds) || 0);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autopilot-scene-"));
  const stockPath = path.join(tmpDir, "stock.mp4");
  const voicePath = path.join(tmpDir, "voice.mp3");
  const outputPath = path.join(tmpDir, "segment.mp4");

  try {
    await downloadToFile(stockUrl, stockPath, "stock");
    await downloadToFile(voiceUrl, voicePath, "voice");

    const sourceDuration = await probeMediaDuration(stockPath);

    await runFfmpegSceneMux(
      stockPath,
      voicePath,
      outputPath,
      targetDuration,
      sourceDuration,
      trimStart,
    );

    const outputDuration = await probeMediaDuration(outputPath);
    const outputStat = await fs.stat(outputPath);

    console.log("[ffmpeg-scene] Scene segment ready", {
      outputPath,
      outputDuration,
      outputMb: (outputStat.size / 1024 / 1024).toFixed(2),
    });

    return {
      path: outputPath,
      duration: outputDuration,
      cleanup: async () => {
        console.log("[ffmpeg-scene] Deleting temp directory", { tmpDir });
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    logFfmpegError("build-scene-segment", error, { stockUrl, voiceUrl, tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
