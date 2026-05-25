import fs from "fs/promises";
import path from "path";
import os from "os";
import ffmpeg from "fluent-ffmpeg";
import {
  ensureFfmpegConfigured,
  logFfmpegError,
} from "@/lib/pipeline/ffmpeg-check";
import { uploadLocalVideo } from "@/lib/pipeline/cloudinary";

const CROSSFADE_SECONDS = 0.5;

const NORMALIZE_VIDEO_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p";

function probeMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

function probeDuration(filePath) {
  return probeMetadata(filePath).then((meta) => {
    const duration = Number(meta?.format?.duration);
    if (!duration || Number.isNaN(duration)) {
      throw new Error(`Could not read duration for ${filePath}`);
    }
    return duration;
  });
}

/**
 * Normalize segment to 1920x1080 @ 30fps yuv420p, AAC 44100Hz stereo (for xfade compatibility).
 */
function normalizeSegment(inputPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const metadata = await probeMetadata(inputPath);
      const hasAudio = metadata.streams?.some((s) => s.codec_type === "audio");
      const duration = Number(metadata.format?.duration) || 10;

      console.log("[ffmpeg] Normalizing segment for concat", {
        inputPath,
        outputPath,
        hasAudio,
        duration,
      });

      let command;

      if (hasAudio) {
        command = ffmpeg(inputPath);
      } else {
        command = ffmpeg()
          .input(inputPath)
          .input("anullsrc=channel_layout=stereo:sample_rate=44100")
          .inputFormat("lavfi")
          .inputOptions([`-t`, String(duration)]);
      }

      const mapOptions = hasAudio
        ? ["-map", "0:v:0", "-map", "0:a:0"]
        : ["-map", "0:v:0", "-map", "1:a:0"];

      command
        .videoFilters(NORMALIZE_VIDEO_FILTER)
        .outputOptions([
          ...mapOptions,
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-c:a",
          "aac",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
          "-shortest",
        ])
        .output(outputPath)
        .on("end", () => {
          console.log("[ffmpeg] Segment normalized", { outputPath });
          resolve();
        })
        .on("error", (err) => {
          logFfmpegError("concat-normalize-segment", err, { inputPath, outputPath });
          reject(err);
        })
        .run();
    } catch (error) {
      reject(error);
    }
  });
}

async function normalizeAllSegments(segmentPaths, tmpDir) {
  const normalizedPaths = [];

  for (let i = 0; i < segmentPaths.length; i++) {
    const normalizedPath = path.join(
      tmpDir,
      `normalized_${String(i).padStart(3, "0")}.mp4`,
    );
    await normalizeSegment(segmentPaths[i], normalizedPath);
    normalizedPaths.push(normalizedPath);
  }

  return normalizedPaths;
}

/**
 * Video xfade chain + hard-cut audio concat (no audio crossfade).
 */
function runFfmpegXfade(segmentPaths, outputPath, crossfadeSec = CROSSFADE_SECONDS) {
  return new Promise(async (resolve, reject) => {
    try {
      const durations = await Promise.all(segmentPaths.map(probeDuration));

      console.log("[ffmpeg] Segment durations for xfade", {
        durations,
        crossfadeSec,
      });

      if (segmentPaths.length === 1) {
        await fs.copyFile(segmentPaths[0], outputPath);
        resolve();
        return;
      }

      const filters = [];
      let currentV = "0:v";
      let accumulated = durations[0];

      for (let i = 1; i < segmentPaths.length; i++) {
        const offset = Math.max(0, accumulated - crossfadeSec);
        const nextV = i === segmentPaths.length - 1 ? "vout" : `xv${i}`;

        filters.push(
          `[${currentV}][${i}:v]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset.toFixed(3)}[${nextV}]`,
        );

        currentV = nextV;
        accumulated += durations[i] - crossfadeSec;
      }

      const audioInputs = segmentPaths.map((_, i) => `[${i}:a]`).join("");
      filters.push(
        `${audioInputs}concat=n=${segmentPaths.length}:v=0:a=1[aout]`,
      );

      const filterComplex = filters.join(";");

      console.log("[ffmpeg] Running video xfade + audio concat (no audio fade)", {
        segmentCount: segmentPaths.length,
        filterComplex,
      });

      const command = ffmpeg();

      for (const segmentPath of segmentPaths) {
        command.input(segmentPath);
      }

      command
        .complexFilter(filterComplex)
        .outputOptions([
          "-map",
          "[vout]",
          "-map",
          "[aout]",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-c:a",
          "aac",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath)
        .on("end", () => {
          console.log("[ffmpeg] Xfade concat complete", { outputPath });
          resolve();
        })
        .on("error", (err) => {
          logFfmpegError("concat-xfade", err, { segmentCount: segmentPaths.length });
          reject(err);
        })
        .run();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Fallback: concat demuxer (no transitions) on normalized segments.
 */
function runFfmpegConcatDemuxer(segmentPaths, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      if (segmentPaths.length === 1) {
        await fs.copyFile(segmentPaths[0], outputPath);
        resolve();
        return;
      }

      const listPath = path.join(path.dirname(outputPath), "concat-fallback.txt");
      const listContent = segmentPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");

      await fs.writeFile(listPath, listContent, "utf8");

      console.log("[ffmpeg] Running concat demuxer fallback", {
        listPath,
        segmentCount: segmentPaths.length,
      });

      const tryConcat = (reencode) =>
        new Promise((res, rej) => {
          const command = ffmpeg()
            .input(listPath)
            .inputOptions(["-f", "concat", "-safe", "0"]);

          if (reencode) {
            command.outputOptions([
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-pix_fmt",
              "yuv420p",
              "-r",
              "30",
              "-c:a",
              "aac",
              "-ar",
              "44100",
              "-ac",
              "2",
              "-movflags",
              "+faststart",
            ]);
          } else {
            command.outputOptions(["-c", "copy"]);
          }

          command
            .output(outputPath)
            .on("end", () => res())
            .on("error", (err) => rej(err))
            .run();
        });

      try {
        await tryConcat(false);
        console.log("[ffmpeg] Concat demuxer fallback complete (stream copy)", {
          outputPath,
        });
        resolve();
      } catch (copyError) {
        console.warn(
          "[ffmpeg] Concat demuxer stream copy failed, re-encoding",
          copyError instanceof Error ? copyError.message : copyError,
        );
        await tryConcat(true);
        console.log("[ffmpeg] Concat demuxer fallback complete (re-encoded)", {
          outputPath,
        });
        resolve();
      }
    } catch (error) {
      reject(error);
    }
  });
}

async function concatNormalizedSegments(
  normalizedPaths,
  outputPath,
  crossfadeSec,
) {
  if (normalizedPaths.length === 1) {
    await fs.copyFile(normalizedPaths[0], outputPath);
    return "single";
  }

  try {
    await runFfmpegXfade(normalizedPaths, outputPath, crossfadeSec);
    return "xfade";
  } catch (xfadeError) {
    console.warn(
      "[ffmpeg] Xfade failed after normalization — falling back to concat demuxer",
      xfadeError instanceof Error ? xfadeError.message : xfadeError,
    );
    await runFfmpegConcatDemuxer(normalizedPaths, outputPath);
    return "concat-demuxer";
  }
}

/**
 * Download scene segment MP4s from Cloudinary URLs, concat locally with FFmpeg, upload final.
 */
export async function concatenateSegmentsWithFfmpeg(
  segmentUrls,
  finalPublicId,
  crossfadeSec = CROSSFADE_SECONDS,
) {
  if (!segmentUrls.length) {
    throw new Error("No segments to concatenate");
  }

  await ensureFfmpegConfigured();

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autopilot-assemble-"),
  );

  console.log("[ffmpeg] Final concat: download Cloudinary segments → FFmpeg → upload", {
    tmpDir,
    segmentCount: segmentUrls.length,
    segmentUrls,
    finalPublicId,
    crossfadeSec,
  });

  try {
    const segmentPaths = [];

    for (let i = 0; i < segmentUrls.length; i++) {
      const url = segmentUrls[i];
      console.log("[ffmpeg] Downloading segment", { index: i, url });

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to download segment ${i}: HTTP ${response.status}`,
        );
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const segmentPath = path.join(
        tmpDir,
        `segment_${String(i).padStart(3, "0")}.mp4`,
      );

      await fs.writeFile(segmentPath, buffer);
      segmentPaths.push(segmentPath);

      const duration = await probeDuration(segmentPath);
      console.log("[ffmpeg] Segment downloaded", {
        index: i,
        bytes: buffer.length,
        duration,
      });
    }

    console.log("[ffmpeg] Normalizing all segments before concat");
    const normalizedPaths = await normalizeAllSegments(segmentPaths, tmpDir);

    const outputPath = path.join(tmpDir, "final.mp4");
    const concatMethod = await concatNormalizedSegments(
      normalizedPaths,
      outputPath,
      crossfadeSec,
    );

    console.log("[ffmpeg] Final concat method", { concatMethod });

    console.log("[ffmpeg] Uploading final MP4 to Cloudinary", { finalPublicId });

    const result = await uploadLocalVideo(outputPath, finalPublicId);

    console.log("[ffmpeg] Final video uploaded", {
      publicId: result.public_id,
      url: result.secure_url,
      duration: result.duration,
      bytes: result.bytes,
    });

    return result;
  } catch (error) {
    logFfmpegError("concat-final", error, {
      finalPublicId,
      segmentCount: segmentUrls.length,
    });
    throw error;
  } finally {
    console.log("[ffmpeg] Deleting temp directory", { tmpDir });
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
