import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import OpenAI from "openai";
import { getErrorMessage } from "@/lib/pipeline/error-message";

const PEXELS_VIDEOS_SEARCH_URL = "https://api.pexels.com/videos/search";
const PIXABAY_VIDEOS_API_URL = "https://pixabay.com/api/videos/";
const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
/** Max Pexels results to try per search before query modifiers. */
const PEXELS_RESULT_LIMIT = 15;
const ARCHIVE_RESULT_LIMIT = 10;
/** Skip Archive.org files larger than this (bytes). */
const ARCHIVE_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Preferred Archive.org video extensions, in priority order. */
const ARCHIVE_VIDEO_EXTENSIONS = [".mp4", ".mpeg", ".mpg", ".avi"];
/** Preferred Archive.org image extensions, in priority order. */
const ARCHIVE_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const OPENAI_IMAGE_MODEL = "gpt-image-1";

const QUERY_MODIFIERS = ["cinematic", "aerial", "close up", "documentary"];

let cloudinaryConfigured = false;
function ensureCloudinaryConfigured() {
  if (cloudinaryConfigured) {
    return;
  }
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  cloudinaryConfigured = true;
}

const IMAGE_EXT_PATTERN = /\.(jpe?g|png|gif|webp|bmp|svg|avif)(\?|$)/i;

/**
 * True only for URLs that point at an MP4 video (never photos).
 */
export function isValidMp4Url(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  const lower = url.toLowerCase().trim();

  if (IMAGE_EXT_PATTERN.test(lower)) {
    return false;
  }

  try {
    const { pathname } = new URL(lower);
    if (IMAGE_EXT_PATTERN.test(pathname)) {
      return false;
    }
    return pathname.endsWith(".mp4") || lower.includes(".mp4");
  } catch {
    return lower.includes(".mp4") && !IMAGE_EXT_PATTERN.test(lower);
  }
}

function isPexelsVideoResult(item) {
  return (
    item &&
    Array.isArray(item.video_files) &&
    item.video_files.length > 0 &&
    !item.src?.large &&
    !item.src?.original
  );
}

function isPixabayVideoHit(hit) {
  return hit && typeof hit === "object" && hit.videos != null;
}

function getMp4FilesFromPexelsVideo(video) {
  if (!isPexelsVideoResult(video)) {
    return [];
  }

  return video.video_files.filter(
    (file) =>
      isMp4FileEntry(file) && isValidMp4Url(file?.link),
  );
}

function isMp4FileEntry(file) {
  return (
    file?.file_type === "video/mp4" ||
    (typeof file?.link === "string" && file.link.toLowerCase().includes(".mp4"))
  );
}

function selectPexelsFile(video) {
  const mp4Files = getMp4FilesFromPexelsVideo(video);
  if (mp4Files.length === 0) return null;

  const files1080 = mp4Files.filter((f) => f.height === 1080);
  if (files1080.length > 0) {
    const best = files1080.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return { url: best.link, height: 1080 };
  }

  const best = [...mp4Files].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  return { url: best.link, height: best.height ?? null };
}

/**
 * Pick the first unused Pexels video from up to PEXELS_RESULT_LIMIT results.
 */
function pickUnusedPexelsVideo(videos, usedPexelsIds, usedFileUrls) {
  const candidates = videos
    .filter(isPexelsVideoResult)
    .slice(0, PEXELS_RESULT_LIMIT);

  for (let i = 0; i < candidates.length; i++) {
    const video = candidates[i];

    if (usedPexelsIds.has(video.id)) {
      console.log("[stock] Skipping duplicate Pexels ID", {
        pexels_id: video.id,
        attempt: i + 1,
        totalCandidates: candidates.length,
      });
      continue;
    }

    const file = selectPexelsFile(video);
    if (!file?.url || !isValidMp4Url(file.url)) {
      continue;
    }

    if (usedFileUrls?.has(file.url)) {
      console.log("[stock] Skipping duplicate file URL", {
        pexels_id: video.id,
        attempt: i + 1,
      });
      continue;
    }

    return {
      url: file.url,
      height: file.height,
      id: video.id,
      duration: Number(video.duration) || null,
    };
  }

  return null;
}

function pickUnusedPixabayVideo(hits, usedPixabayIds, usedFileUrls) {
  const candidates = hits.filter(isPixabayVideoHit).slice(0, PEXELS_RESULT_LIMIT);

  for (let i = 0; i < candidates.length; i++) {
    const hit = candidates[i];

    if (hit.id != null && usedPixabayIds?.has(hit.id)) {
      console.log("[stock] Skipping duplicate Pixabay ID", {
        pixabay_id: hit.id,
        attempt: i + 1,
      });
      continue;
    }

    const pick = pickPixabayVideoFromHit(hit);
    if (!pick?.url || !isValidMp4Url(pick.url)) {
      continue;
    }

    if (usedFileUrls?.has(pick.url)) {
      console.log("[stock] Skipping duplicate Pixabay URL", {
        pixabay_id: hit.id,
        attempt: i + 1,
      });
      continue;
    }

    return pick;
  }

  return null;
}

function pickPixabayVideoFromHit(hit) {
  if (!isPixabayVideoHit(hit)) {
    return null;
  }

  const sizes = ["large", "medium", "small", "tiny"];

  for (const size of sizes) {
    const url = hit.videos?.[size]?.url;
    if (!isValidMp4Url(url)) {
      continue;
    }

    const height =
      size === "large" ? 1080 : size === "medium" ? 720 : null;

    return {
      url,
      height,
      duration: Number(hit.duration) || null,
      id: hit.id,
    };
  }

  return null;
}

/**
 * Keywords to try: full phrase, then first word only as fallback.
 */
export function getSearchKeywords(visualKeyword) {
  const trimmed = visualKeyword.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const keywords = [trimmed];

  if (words.length > 1) {
    keywords.push(words[0]);
  }

  return [...new Set(keywords)];
}

/**
 * Random start offset in [0, (stock_duration - voice_duration) / 2].
 * Shorter stock than voice returns 0 (FFmpeg will loop to fill).
 */
export function computeRandomTrimStart(stockDurationSec, voiceDurationSec) {
  const stock = Number(stockDurationSec) || 0;
  const voice = Math.max(0.1, Number(voiceDurationSec) || 10);

  if (stock <= voice) {
    return 0;
  }

  const maxStart = (stock - voice) / 2;
  if (maxStart <= 0) {
    return 0;
  }

  const start = Math.random() * maxStart;
  return Math.round(start * 1000) / 1000;
}

function buildStockResult(
  pick,
  source,
  visualKeyword,
  searchKeyword,
  voiceDuration,
  extra = {},
) {
  const duration = Math.max(0.1, Number(voiceDuration) || 10);
  const trim_start = computeRandomTrimStart(pick.duration, duration);
  const isArchiveSource = source === "archive" || source === "archive_image";

  return {
    file_url: pick.url,
    source,
    pexels_id: source === "pexels" ? (pick.id ?? null) : null,
    pixabay_id: source === "pixabay" ? (pick.id ?? null) : null,
    archive_id: isArchiveSource ? (pick.id ?? null) : null,
    archive_title: isArchiveSource ? (pick.title ?? null) : null,
    stock_duration: pick.duration,
    trim_start,
    trim_end: duration,
    duration,
    search_keyword: searchKeyword,
    matched_keyword: visualKeyword,
    needs_ken_burns: false,
    ...extra,
  };
}

function markStockAsUsed(pick, source, usedPexelsIds, usedPixabayIds, usedFileUrls) {
  if (source === "pexels" && pick.id != null) {
    usedPexelsIds.add(pick.id);
  }
  if (source === "pixabay" && pick.id != null) {
    usedPixabayIds.add(pick.id);
  }
  if (pick.url) {
    usedFileUrls.add(pick.url);
  }
}

async function searchPexelsVideos(keyword, usedPexelsIds, usedFileUrls) {
  const query = encodeURIComponent(keyword);

  console.log("[stock] Pexels video search", {
    endpoint: PEXELS_VIDEOS_SEARCH_URL,
    keyword,
  });

  const pexelsRes = await axios.get(PEXELS_VIDEOS_SEARCH_URL, {
    params: {
      query: keyword,
      per_page: PEXELS_RESULT_LIMIT,
      orientation: "landscape",
    },
    headers: { Authorization: process.env.PEXELS_API_KEY },
    timeout: 30000,
  });

  if (pexelsRes.data?.photos && !pexelsRes.data?.videos) {
    console.warn("[stock] Pexels returned photos payload — ignoring (videos only)");
    return null;
  }

  const videos = (pexelsRes.data?.videos || []).filter(isPexelsVideoResult);
  const picked = pickUnusedPexelsVideo(videos, usedPexelsIds, usedFileUrls);

  if (!picked?.url || !isValidMp4Url(picked.url)) {
    return null;
  }

  return picked;
}

async function searchPixabayVideos(keyword, usedPixabayIds, usedFileUrls) {
  console.log("[stock] Pixabay video search", {
    endpoint: PIXABAY_VIDEOS_API_URL,
    keyword,
    video_type: "film",
  });

  const pixabayRes = await axios.get(PIXABAY_VIDEOS_API_URL, {
    params: {
      key: process.env.PIXABAY_API_KEY,
      q: keyword,
      video_type: "film",
      per_page: PEXELS_RESULT_LIMIT,
    },
    timeout: 30000,
  });

  const hits = (pixabayRes.data?.hits || []).filter(isPixabayVideoHit);
  return pickUnusedPixabayVideo(hits, usedPixabayIds, usedFileUrls);
}

function getArchiveExtensionRank(name) {
  const lower = String(name || "").toLowerCase();
  for (let i = 0; i < ARCHIVE_VIDEO_EXTENSIONS.length; i++) {
    if (lower.endsWith(ARCHIVE_VIDEO_EXTENSIONS[i])) {
      return i;
    }
  }
  return -1;
}

function isLikelyAudioOnlyFile(file) {
  const format = String(file?.format || "").toLowerCase();
  const name = String(file?.name || "").toLowerCase();
  const audioFormats = ["mp3", "flac", "wav", "ogg", "aiff", "m4a", "audio"];
  if (audioFormats.some((fmt) => format.includes(fmt))) {
    return true;
  }
  return /\.(mp3|flac|wav|ogg|aiff|m4a)$/.test(name);
}

/**
 * Pick the best video file from an Archive.org metadata file list:
 * prefer .mp4 → .mpeg → .avi, prefer files under 100MB, skip audio-only.
 */
function pickBestArchiveFile(files) {
  if (!Array.isArray(files)) {
    return null;
  }

  const candidates = files
    .filter((file) => {
      if (!file?.name || isLikelyAudioOnlyFile(file)) {
        return false;
      }
      return getArchiveExtensionRank(file.name) >= 0;
    })
    .map((file) => {
      const size = Number(file.size) || 0;
      return {
        name: file.name,
        size,
        extRank: getArchiveExtensionRank(file.name),
        underLimit: size > 0 && size <= ARCHIVE_MAX_FILE_BYTES,
      };
    });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.underLimit !== b.underLimit) {
      return a.underLimit ? -1 : 1;
    }
    if (a.extRank !== b.extRank) {
      return a.extRank - b.extRank;
    }
    return (a.size || Infinity) - (b.size || Infinity);
  });

  return candidates[0];
}

/**
 * Search Archive.org for a movie clip and resolve a direct video file URL.
 * @returns {Promise<{ url: string, id: string, title: string, duration: number|null } | null>}
 */
export async function fetchArchiveOrgClip(visualKeyword, usedFileUrls = new Set()) {
  const query = String(visualKeyword || "").trim();
  if (!query) {
    return null;
  }

  console.log("[stock] Archive.org search", {
    endpoint: ARCHIVE_SEARCH_URL,
    keyword: query,
  });

  const searchRes = await axios.get(ARCHIVE_SEARCH_URL, {
    params: {
      q: query,
      mediatype: "movies",
      "fl[]": ["identifier", "title", "description"],
      rows: ARCHIVE_RESULT_LIMIT,
      output: "json",
    },
    timeout: 30000,
  });

  const docs = searchRes.data?.response?.docs;
  if (!Array.isArray(docs) || docs.length === 0) {
    console.log("[stock] Archive.org no results", { keyword: query });
    return null;
  }

  for (const doc of docs) {
    const identifier = doc?.identifier;
    if (!identifier) {
      continue;
    }

    let metadata;
    try {
      const metaRes = await axios.get(`${ARCHIVE_METADATA_URL}/${identifier}`, {
        timeout: 30000,
      });
      metadata = metaRes.data;
    } catch (error) {
      console.warn("[stock] Archive.org metadata fetch failed", {
        identifier,
        message: getErrorMessage(error),
      });
      continue;
    }

    const best = pickBestArchiveFile(metadata?.files);
    if (!best) {
      continue;
    }

    const server = metadata?.server;
    const dir = metadata?.dir;
    const fileUrl =
      server && dir
        ? `https://${server}${dir}/${encodeURIComponent(best.name)}`
        : `https://archive.org/download/${identifier}/${encodeURIComponent(best.name)}`;

    if (usedFileUrls.has(fileUrl)) {
      console.log("[stock] Skipping duplicate Archive.org URL", { identifier });
      continue;
    }

    const title = String(doc?.title || metadata?.metadata?.title || identifier);
    const duration = Number(metadata?.metadata?.runtime) || null;

    console.log("[stock] Archive.org clip found", {
      identifier,
      title,
      file: best.name,
      sizeBytes: best.size,
      url: fileUrl,
    });

    return { url: fileUrl, id: identifier, title, duration };
  }

  console.log("[stock] Archive.org no results", {
    keyword: query,
    reason: "no usable video files in metadata",
  });
  return null;
}

/**
 * Pick the best still image file from an Archive.org metadata file list.
 * Prefer .jpg → .jpeg → .png, prefer files under 100MB.
 */
function pickBestArchiveImageFile(files) {
  if (!Array.isArray(files)) {
    return null;
  }

  const rankExt = (name) => {
    const lower = String(name || "").toLowerCase();
    for (let i = 0; i < ARCHIVE_IMAGE_EXTENSIONS.length; i++) {
      if (lower.endsWith(ARCHIVE_IMAGE_EXTENSIONS[i])) {
        return i;
      }
    }
    return -1;
  };

  const candidates = files
    .filter((file) => file?.name && rankExt(file.name) >= 0)
    // Archive.org generates tiny thumbnails (e.g. *_thumb.jpg); skip those.
    .filter((file) => !/(thumb|__ia_thumb|_itemimage)/i.test(file.name))
    .map((file) => {
      const size = Number(file.size) || 0;
      return {
        name: file.name,
        size,
        extRank: rankExt(file.name),
        underLimit: size > 0 && size <= ARCHIVE_MAX_FILE_BYTES,
      };
    });

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.underLimit !== b.underLimit) {
      return a.underLimit ? -1 : 1;
    }
    if (a.extRank !== b.extRank) {
      return a.extRank - b.extRank;
    }
    // Prefer larger (higher-quality) images for Ken Burns.
    return (b.size || 0) - (a.size || 0);
  });

  return candidates[0];
}

/**
 * Search Archive.org for a still image and resolve a direct image file URL.
 * @returns {Promise<{ url: string, id: string, title: string, duration: null } | null>}
 */
async function fetchArchiveOrgImage(visualKeyword, usedFileUrls = new Set()) {
  const query = String(visualKeyword || "").trim();
  if (!query) {
    return null;
  }

  console.log("[stock] Archive.org image search", {
    endpoint: ARCHIVE_SEARCH_URL,
    keyword: query,
  });

  const searchRes = await axios.get(ARCHIVE_SEARCH_URL, {
    params: {
      q: query,
      mediatype: "image",
      "fl[]": ["identifier", "title", "description"],
      rows: ARCHIVE_RESULT_LIMIT,
      output: "json",
    },
    timeout: 30000,
  });

  const docs = searchRes.data?.response?.docs;
  if (!Array.isArray(docs) || docs.length === 0) {
    console.log("[stock] Archive.org no image results", { keyword: query });
    return null;
  }

  for (const doc of docs) {
    const identifier = doc?.identifier;
    if (!identifier) {
      continue;
    }

    let metadata;
    try {
      const metaRes = await axios.get(`${ARCHIVE_METADATA_URL}/${identifier}`, {
        timeout: 30000,
      });
      metadata = metaRes.data;
    } catch (error) {
      console.warn("[stock] Archive.org image metadata fetch failed", {
        identifier,
        message: getErrorMessage(error),
      });
      continue;
    }

    const best = pickBestArchiveImageFile(metadata?.files);
    if (!best) {
      continue;
    }

    const server = metadata?.server;
    const dir = metadata?.dir;
    const fileUrl =
      server && dir
        ? `https://${server}${dir}/${encodeURIComponent(best.name)}`
        : `https://archive.org/download/${identifier}/${encodeURIComponent(best.name)}`;

    if (usedFileUrls.has(fileUrl)) {
      console.log("[stock] Skipping duplicate Archive.org image URL", { identifier });
      continue;
    }

    const title = String(doc?.title || metadata?.metadata?.title || identifier);

    console.log("[stock] Archive.org image found", {
      identifier,
      title,
      file: best.name,
      url: fileUrl,
    });

    return { url: fileUrl, id: identifier, title, duration: null };
  }

  console.log("[stock] Archive.org no image results", {
    keyword: query,
    reason: "no usable image files in metadata",
  });
  return null;
}

/**
 * Generate an image of the subject with OpenAI gpt-image-1 and host it on Cloudinary.
 * @returns {Promise<{ url: string, id: string, title: string, duration: null } | null>}
 */
async function generateOpenAiImage(subject, apiKey) {
  const cleanSubject = String(subject || "").trim();
  if (!cleanSubject) {
    return null;
  }

  console.log("[stock] Generating image with OpenAI gpt-image-1", {
    subject: cleanSubject,
  });

  const client = new OpenAI({ apiKey });
  const prompt = `Photorealistic, historically accurate documentary photograph of ${cleanSubject}. Cinematic lighting, high detail, period-accurate. No text, captions, watermarks, or borders.`;

  const result = await client.images.generate({
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size: "1536x1024",
    n: 1,
  });

  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) {
    console.log("[stock] OpenAI image generation returned no data", {
      subject: cleanSubject,
    });
    return null;
  }

  ensureCloudinaryConfigured();
  const upload = await cloudinary.uploader.upload(
    `data:image/png;base64,${b64}`,
    {
      resource_type: "image",
      folder: "autopilot/generated",
      overwrite: false,
      timeout: 120000,
    },
  );

  console.log("[stock] OpenAI image uploaded to Cloudinary", {
    subject: cleanSubject,
    url: upload.secure_url,
  });

  return {
    url: upload.secure_url,
    id: upload.public_id,
    title: cleanSubject,
    duration: null,
  };
}

async function tryArchiveVideo(query, sets, neededDuration) {
  try {
    const pick = await fetchArchiveOrgClip(query, sets.usedFileUrls);
    if (pick) {
      markStockAsUsed(
        pick,
        "archive",
        sets.usedPexelsIds,
        sets.usedPixabayIds,
        sets.usedFileUrls,
      );
      console.log("[stock] Archive.org video clip selected", {
        keyword: query,
        url: pick.url,
        identifier: pick.id,
        title: pick.title,
      });
      return buildStockResult(pick, "archive", query, query, neededDuration);
    }
  } catch (error) {
    console.warn("[stock] Archive.org search failed", {
      keyword: query,
      message: getErrorMessage(error),
    });
  }
  return null;
}

async function tryPexels(query, sets, neededDuration) {
  try {
    const pick = await searchPexelsVideos(query, sets.usedPexelsIds, sets.usedFileUrls);
    if (pick) {
      markStockAsUsed(
        pick,
        "pexels",
        sets.usedPexelsIds,
        sets.usedPixabayIds,
        sets.usedFileUrls,
      );
      console.log("[stock] Pexels video clip selected", {
        keyword: query,
        url: pick.url,
        pexels_id: pick.id,
        height: pick.height,
        usedPexelsCount: sets.usedPexelsIds.size,
      });
      return buildStockResult(pick, "pexels", query, query, neededDuration);
    }
  } catch (error) {
    console.warn("[stock] Pexels video search failed", {
      keyword: query,
      message: getErrorMessage(error),
    });
  }
  return null;
}

async function tryPixabay(query, sets, neededDuration) {
  try {
    const pick = await searchPixabayVideos(query, sets.usedPixabayIds, sets.usedFileUrls);
    if (pick) {
      markStockAsUsed(
        pick,
        "pixabay",
        sets.usedPexelsIds,
        sets.usedPixabayIds,
        sets.usedFileUrls,
      );
      console.log("[stock] Pixabay video clip selected", {
        keyword: query,
        url: pick.url,
        pixabay_id: pick.id,
        usedPixabayCount: sets.usedPixabayIds.size,
      });
      return buildStockResult(pick, "pixabay", query, query, neededDuration);
    }
  } catch (error) {
    console.warn("[stock] Pixabay video search failed", {
      keyword: query,
      message: getErrorMessage(error),
    });
  }
  return null;
}

/**
 * image_zoom: find a still image (Archive.org first, then OpenAI generation),
 * flagged needs_ken_burns so the assembler applies a Ken Burns zoom.
 */
async function tryImageZoom(query, options, sets, neededDuration) {
  try {
    const imgPick = await fetchArchiveOrgImage(query, sets.usedFileUrls);
    if (imgPick) {
      markStockAsUsed(
        imgPick,
        "archive_image",
        sets.usedPexelsIds,
        sets.usedPixabayIds,
        sets.usedFileUrls,
      );
      console.log("[stock] Archive.org image selected (Ken Burns)", {
        keyword: query,
        url: imgPick.url,
        identifier: imgPick.id,
      });
      return buildStockResult(imgPick, "archive_image", query, query, neededDuration, {
        needs_ken_burns: true,
      });
    }
  } catch (error) {
    console.warn("[stock] Archive.org image search failed", {
      keyword: query,
      message: getErrorMessage(error),
    });
  }

  const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[stock] No OpenAI API key — cannot generate image_zoom image", {
      keyword: query,
    });
    return null;
  }

  try {
    const gen = await generateOpenAiImage(query, apiKey);
    if (gen) {
      sets.usedFileUrls.add(gen.url);
      return buildStockResult(gen, "openai", query, query, neededDuration, {
        needs_ken_burns: true,
      });
    }
  } catch (error) {
    console.warn("[stock] OpenAI image generation failed", {
      keyword: query,
      message: getErrorMessage(error),
    });
  }

  return null;
}

async function fetchStockVideoForKeyword(visualKeyword, options) {
  const sets = {
    usedPexelsIds: options.usedPexelsIds ?? new Set(),
    usedPixabayIds: options.usedPixabayIds ?? new Set(),
    usedFileUrls: options.usedFileUrls ?? new Set(),
  };
  const neededDuration = options.neededDuration ?? 10;
  const strategy = options.footageStrategy ?? "stock";

  // "image_zoom" → still image (Archive.org image, else OpenAI), then video fallbacks.
  if (strategy === "image_zoom") {
    const imageResult = await tryImageZoom(visualKeyword, options, sets, neededDuration);
    if (imageResult) {
      return imageResult;
    }
    return (
      (await tryArchiveVideo(visualKeyword, sets, neededDuration)) ||
      (await tryPexels(visualKeyword, sets, neededDuration)) ||
      (await tryPixabay(visualKeyword, sets, neededDuration))
    );
  }

  // "archive" → Archive.org first, then Pexels, then Pixabay.
  if (strategy === "archive") {
    return (
      (await tryArchiveVideo(visualKeyword, sets, neededDuration)) ||
      (await tryPexels(visualKeyword, sets, neededDuration)) ||
      (await tryPixabay(visualKeyword, sets, neededDuration))
    );
  }

  // "stock" (default) → Pexels first, then Pixabay, then Archive.org.
  return (
    (await tryPexels(visualKeyword, sets, neededDuration)) ||
    (await tryPixabay(visualKeyword, sets, neededDuration)) ||
    (await tryArchiveVideo(visualKeyword, sets, neededDuration))
  );
}

function buildQueriesForKeyword(keyword) {
  const trimmed = keyword.trim();
  const queries = [trimmed];

  for (const mod of QUERY_MODIFIERS) {
    queries.push(`${trimmed} ${mod}`);
  }

  return [...new Set(queries)];
}

function isAcceptableFootageResult(result) {
  if (!result?.file_url) {
    return false;
  }
  // Image (Ken Burns) and Archive.org results bypass the MP4-only gate.
  if (result.needs_ken_burns === true) {
    return true;
  }
  if (result.source === "archive") {
    return true;
  }
  return isValidMp4Url(result.file_url);
}

/**
 * @param {string} visualKeyword
 * @param {{
 *   usedPexelsIds?: Set<number>,
 *   usedPixabayIds?: Set<number>,
 *   usedFileUrls?: Set<string>,
 *   neededDuration?: number,
 *   footageStrategy?: "archive" | "stock" | "image_zoom",
 *   searchQuery?: string,
 *   openaiApiKey?: string,
 * }} options
 */
export async function fetchStockVideo(visualKeyword, options = {}) {
  const usedPexelsIds = options.usedPexelsIds ?? new Set();
  const usedPixabayIds = options.usedPixabayIds ?? new Set();
  const usedFileUrls = options.usedFileUrls ?? new Set();
  const footageStrategy = options.footageStrategy ?? "stock";
  const searchQuery = String(options.searchQuery || "").trim();
  const stockOptions = {
    ...options,
    footageStrategy,
    usedPexelsIds,
    usedPixabayIds,
    usedFileUrls,
  };

  const baseKeywords = getSearchKeywords(visualKeyword);
  const queriesToTry = [];

  // Claude's specific searchQuery takes priority over the generic keyword.
  if (searchQuery) {
    queriesToTry.push(searchQuery);
  }
  for (const base of baseKeywords) {
    queriesToTry.push(...buildQueriesForKeyword(base));
  }
  const dedupedQueries = [...new Set(queriesToTry.filter(Boolean))];

  console.log("[stock] Fetching footage", {
    visualKeyword,
    footageStrategy,
    searchQuery,
    queriesToTry: dedupedQueries,
    usedPexelsCount: usedPexelsIds.size,
    usedPixabayCount: usedPixabayIds.size,
    usedUrlCount: usedFileUrls.size,
  });

  for (const query of dedupedQueries) {
    const result = await fetchStockVideoForKeyword(query, stockOptions);
    if (isAcceptableFootageResult(result)) {
      if (query !== searchQuery && query !== visualKeyword.trim()) {
        console.log("[stock] Used alternate search query", {
          original: visualKeyword,
          query,
        });
      }
      return result;
    }
  }

  throw new Error(
    `No unused footage found for keyword: ${visualKeyword} (strategy: ${footageStrategy}, tried ${dedupedQueries.length} queries)`,
  );
}
