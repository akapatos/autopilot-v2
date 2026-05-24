import fs from "fs/promises";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import {
  ensureFfmpegConfigured,
  logFfmpegError,
} from "@/lib/pipeline/ffmpeg-check";

export function probeMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      const duration = Number(metadata?.format?.duration);
      if (!duration || Number.isNaN(duration)) {
        reject(new Error(`Could not read duration for ${filePath}`));
        return;
      }
      resolve(duration);
    });
  });
}

function runFfmpegPrepare(
  inputPath,
  outputPath,
  targetDuration,
  sourceDuration,
  trimStart = 0,
) {
  return new Promise((resolve, reject) => {
    const availableDuration = Math.max(0.1, sourceDuration - trimStart);
    const needsLoop = targetDuration > availableDuration + 0.05;
    const streamLoop = needsLoop
      ? Math.max(0, Math.ceil(targetDuration / availableDuration) - 1)
      : 0;

    console.log("[ffmpeg-prepare] Normalising stock footage", {
      inputPath,
      outputPath,
      targetDuration,
      sourceDuration,
      trimStart,
      availableDuration,
      needsLoop,
      streamLoop,
      resolution: "1920x1080",
      crf: 28,
    });

    let command = ffmpeg();
    const inputOptions = [`-ss`, String(trimStart)];

    if (needsLoop) {
      command = command
        .input(inputPath)
        .inputOptions([...inputOptions, "-stream_loop", String(streamLoop)]);
    } else {
      command = command.input(inputPath).inputOptions(inputOptions);
    }

    command
      .duration(targetDuration)
      .videoFilters(
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
      )
      .outputOptions([
        "-c:v",
        "libx264",
        "-crf",
        "28",
        "-preset",
        "fast",
        "-an",
        "-movflags",
        "+faststart",
      ])
      .output(outputPath)
      .on("end", () => {
        console.log("[ffmpeg-prepare] Normalisation complete", { outputPath });
        resolve();
      })
      .on("error", (err) => {
        logFfmpegError("prepare-normalise", err, { inputPath, outputPath });
        reject(err);
      })
      .run();
  });
}

/**
 * Download stock footage, loop if shorter than voiceover, normalise to 1080p H.264.
 * @param {string} remoteUrl
 * @param {number} voiceDurationSeconds - target scene length (voiceover duration)
 * @param {number} trimStartSeconds - offset into source clip (random start from stock search)
 */
export async function prepareStockClip(
  remoteUrl,
  voiceDurationSeconds,
  trimStartSeconds = 0,
) {
  await ensureFfmpegConfigured();

  const targetDuration = Math.max(0.1, Number(voiceDurationSeconds) || 10);
  const trimStart = Math.max(0, Number(trimStartSeconds) || 0);
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autopilot-prepare-"),
  );
  const inputPath = path.join(tmpDir, "source.mp4");
  const outputPath = path.join(tmpDir, "prepared.mp4");

  console.log("[ffmpeg-prepare] Downloading stock footage", { remoteUrl, tmpDir });

  try {
    const response = await fetch(remoteUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download stock footage: HTTP ${response.status}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(inputPath, buffer);

    const inputStat = await fs.stat(inputPath);
    const sourceDuration = await probeMediaDuration(inputPath);

    console.log("[ffmpeg-prepare] Source downloaded", {
      bytes: inputStat.size,
      sourceDuration,
      targetDuration,
      trimStart,
    });

    await runFfmpegPrepare(
      inputPath,
      outputPath,
      targetDuration,
      sourceDuration,
      trimStart,
    );

    const outputStat = await fs.stat(outputPath);
    const outputDuration = await probeMediaDuration(outputPath);

    console.log("[ffmpeg-prepare] Prepared clip ready", {
      outputPath,
      outputDuration,
      inputMb: (inputStat.size / 1024 / 1024).toFixed(2),
      outputMb: (outputStat.size / 1024 / 1024).toFixed(2),
    });

    return {
      path: outputPath,
      duration: outputDuration,
      cleanup: async () => {
        console.log("[ffmpeg-prepare] Deleting temp directory", { tmpDir });
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    logFfmpegError("prepare-stock-clip", error, { remoteUrl, tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
