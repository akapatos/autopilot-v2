import axios from "axios";
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

const QUERY_MODIFIERS = ["cinematic", "aerial", "close up", "documentary"];

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

function buildStockResult(pick, source, visualKeyword, searchKeyword, voiceDuration) {
  const duration = Math.max(0.1, Number(voiceDuration) || 10);
  const trim_start = computeRandomTrimStart(pick.duration, duration);

  return {
    file_url: pick.url,
    source,
    pexels_id: source === "pexels" ? (pick.id ?? null) : null,
    pixabay_id: source === "pixabay" ? (pick.id ?? null) : null,
    archive_id: source === "archive" ? (pick.id ?? null) : null,
    archive_title: source === "archive" ? (pick.title ?? null) : null,
    stock_duration: pick.duration,
    trim_start,
    trim_end: duration,
    duration,
    search_keyword: searchKeyword,
    matched_keyword: visualKeyword,
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

async function fetchStockVideoForKeyword(visualKeyword, options) {
  const usedPexelsIds = options.usedPexelsIds ?? new Set();
  const usedPixabayIds = options.usedPixabayIds ?? new Set();
  const usedFileUrls = options.usedFileUrls ?? new Set();
  const neededDuration = options.neededDuration ?? 10;

  // TEMPORARY: Archive.org is the primary source (tried before Pexels/Pixabay).
  try {
    const archivePick = await fetchArchiveOrgClip(visualKeyword, usedFileUrls);
    if (archivePick) {
      markStockAsUsed(
        archivePick,
        "archive",
        usedPexelsIds,
        usedPixabayIds,
        usedFileUrls,
      );
      console.log("[stock] Archive.org video clip selected", {
        keyword: visualKeyword,
        url: archivePick.url,
        identifier: archivePick.id,
        title: archivePick.title,
      });
      return buildStockResult(
        archivePick,
        "archive",
        visualKeyword,
        visualKeyword,
        neededDuration,
      );
    }
  } catch (error) {
    console.warn("[stock] Archive.org search failed", {
      keyword: visualKeyword,
      message: getErrorMessage(error),
    });
  }

  try {
    const pexelsPick = await searchPexelsVideos(
      visualKeyword,
      usedPexelsIds,
      usedFileUrls,
    );
    if (pexelsPick) {
      markStockAsUsed(
        pexelsPick,
        "pexels",
        usedPexelsIds,
        usedPixabayIds,
        usedFileUrls,
      );
      console.log("[stock] Pexels video clip selected", {
        keyword: visualKeyword,
        url: pexelsPick.url,
        pexels_id: pexelsPick.id,
        height: pexelsPick.height,
        usedPexelsCount: usedPexelsIds.size,
      });
      return buildStockResult(
        pexelsPick,
        "pexels",
        visualKeyword,
        visualKeyword,
        neededDuration,
      );
    }
  } catch (error) {
    console.warn("[stock] Pexels video search failed", {
      keyword: visualKeyword,
      message: getErrorMessage(error),
    });
  }

  try {
    const pixabayPick = await searchPixabayVideos(
      visualKeyword,
      usedPixabayIds,
      usedFileUrls,
    );
    if (pixabayPick) {
      markStockAsUsed(
        pixabayPick,
        "pixabay",
        usedPexelsIds,
        usedPixabayIds,
        usedFileUrls,
      );
      console.log("[stock] Pixabay video clip selected", {
        keyword: visualKeyword,
        url: pixabayPick.url,
        pixabay_id: pixabayPick.id,
        usedPixabayCount: usedPixabayIds.size,
      });
      return buildStockResult(
        pixabayPick,
        "pixabay",
        visualKeyword,
        visualKeyword,
        neededDuration,
      );
    }
  } catch (error) {
    console.warn("[stock] Pixabay video search failed", {
      keyword: visualKeyword,
      message: getErrorMessage(error),
    });
  }

  return null;
}

function buildQueriesForKeyword(keyword) {
  const trimmed = keyword.trim();
  const queries = [trimmed];

  for (const mod of QUERY_MODIFIERS) {
    queries.push(`${trimmed} ${mod}`);
  }

  return [...new Set(queries)];
}

/**
 * @param {string} visualKeyword
 * @param {{
 *   usedPexelsIds?: Set<number>,
 *   usedPixabayIds?: Set<number>,
 *   usedFileUrls?: Set<string>,
 *   neededDuration?: number,
 * }} options
 */
export async function fetchStockVideo(visualKeyword, options = {}) {
  const usedPexelsIds = options.usedPexelsIds ?? new Set();
  const usedPixabayIds = options.usedPixabayIds ?? new Set();
  const usedFileUrls = options.usedFileUrls ?? new Set();
  const stockOptions = {
    ...options,
    usedPexelsIds,
    usedPixabayIds,
    usedFileUrls,
  };

  const baseKeywords = getSearchKeywords(visualKeyword);
  const queriesToTry = [];

  for (const base of baseKeywords) {
    queriesToTry.push(...buildQueriesForKeyword(base));
  }

  console.log("[stock] Fetching stock video (MP4 only)", {
    visualKeyword,
    queriesToTry,
    usedPexelsCount: usedPexelsIds.size,
    usedPixabayCount: usedPixabayIds.size,
    usedUrlCount: usedFileUrls.size,
  });

  for (const query of queriesToTry) {
    const result = await fetchStockVideoForKeyword(query, stockOptions);
    const isAcceptable =
      result?.file_url &&
      (isValidMp4Url(result.file_url) || result.source === "archive");
    if (isAcceptable) {
      if (query !== visualKeyword.trim()) {
        console.log("[stock] Used alternate search query", {
          original: visualKeyword,
          query,
        });
      }
      return result;
    }
  }

  throw new Error(
    `No unused stock video found for keyword: ${visualKeyword} (tried ${queriesToTry.length} queries)`,
  );
}
