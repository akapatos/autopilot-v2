import axios from "axios";

const PEXELS_VIDEOS_SEARCH_URL = "https://api.pexels.com/videos/search";
const PIXABAY_VIDEOS_API_URL = "https://pixabay.com/api/videos/";
const SEARCH_LIMIT = 10;

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

function pickUnusedPexelsVideo(videos, usedPexelsIds) {
  const candidates = videos
    .filter(isPexelsVideoResult)
    .slice(0, SEARCH_LIMIT);

  for (const video of candidates) {
    if (usedPexelsIds.has(video.id)) {
      continue;
    }

    const file = selectPexelsFile(video);
    if (!file?.url || !isValidMp4Url(file.url)) {
      continue;
    }

    return {
      url: file.url,
      height: file.height,
      id: video.id,
      duration: Number(video.duration) || null,
    };
  }

  let bestUrl = null;
  let bestHeight = 0;
  let bestId = null;
  let bestDuration = null;

  for (const video of candidates) {
    if (usedPexelsIds.has(video.id)) {
      continue;
    }

    for (const file of getMp4FilesFromPexelsVideo(video)) {
      if (!isValidMp4Url(file.link)) {
        continue;
      }
      const height = file.height || 0;
      if (height > bestHeight) {
        bestHeight = height;
        bestUrl = file.link;
        bestId = video.id;
        bestDuration = Number(video.duration) || null;
      }
    }
  }

  if (!bestUrl) {
    return null;
  }

  return {
    url: bestUrl,
    height: bestHeight,
    id: bestId,
    duration: bestDuration,
  };
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

export function computeRandomTrimStart(stockDurationSec, neededDurationSec) {
  const stock = Number(stockDurationSec) || 0;
  const needed = Math.max(0.1, Number(neededDurationSec) || 10);

  if (stock <= needed + 0.5) {
    return 0;
  }

  const maxStart = stock - needed - 0.25;
  const start = Math.random() * maxStart;
  return Math.round(start * 1000) / 1000;
}

function buildStockResult(pick, source, visualKeyword, searchKeyword, neededDuration) {
  const trim_start = computeRandomTrimStart(pick.duration, neededDuration);

  return {
    file_url: pick.url,
    source,
    pexels_id: pick.id ?? null,
    stock_duration: pick.duration,
    trim_start,
    search_keyword: searchKeyword,
    matched_keyword: visualKeyword,
  };
}

async function searchPexelsVideos(keyword, usedPexelsIds) {
  const query = encodeURIComponent(keyword);

  console.log("[stock] Pexels video search", {
    endpoint: PEXELS_VIDEOS_SEARCH_URL,
    keyword,
  });

  const pexelsRes = await axios.get(PEXELS_VIDEOS_SEARCH_URL, {
    params: {
      query: keyword,
      per_page: SEARCH_LIMIT,
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
  const picked = pickUnusedPexelsVideo(videos, usedPexelsIds);

  if (!picked?.url || !isValidMp4Url(picked.url)) {
    return null;
  }

  return picked;
}

async function searchPixabayVideos(keyword) {
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
      per_page: SEARCH_LIMIT,
    },
    timeout: 30000,
  });

  const hits = (pixabayRes.data?.hits || []).filter(isPixabayVideoHit);

  for (const hit of hits) {
    const pick = pickPixabayVideoFromHit(hit);
    if (pick?.url && isValidMp4Url(pick.url)) {
      return pick;
    }
  }

  return null;
}

async function fetchStockVideoForKeyword(visualKeyword, options) {
  const usedPexelsIds = options.usedPexelsIds ?? new Set();
  const neededDuration = options.neededDuration ?? 10;

  try {
    const pexelsPick = await searchPexelsVideos(visualKeyword, usedPexelsIds);
    if (pexelsPick) {
      console.log("[stock] Pexels video clip selected", {
        keyword: visualKeyword,
        url: pexelsPick.url,
        pexels_id: pexelsPick.id,
        height: pexelsPick.height,
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
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const pixabayPick = await searchPixabayVideos(visualKeyword);
    if (pixabayPick) {
      console.log("[stock] Pixabay video clip selected", {
        keyword: visualKeyword,
        url: pixabayPick.url,
        id: pixabayPick.id,
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
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

/**
 * @param {string} visualKeyword
 * @param {{ usedPexelsIds?: Set<number>, neededDuration?: number }} options
 */
export async function fetchStockVideo(visualKeyword, options = {}) {
  const keywords = getSearchKeywords(visualKeyword);

  console.log("[stock] Fetching stock video (MP4 only)", {
    visualKeyword,
    keywordsToTry: keywords,
    usedPexelsCount: options.usedPexelsIds?.size ?? 0,
  });

  for (const keyword of keywords) {
    const result = await fetchStockVideoForKeyword(keyword, options);
    if (result?.file_url && isValidMp4Url(result.file_url)) {
      if (keyword !== visualKeyword.trim()) {
        console.log("[stock] Used fallback keyword", {
          original: visualKeyword,
          fallback: keyword,
        });
      }
      return result;
    }
  }

  throw new Error(
    `No MP4 stock video found for keyword: ${visualKeyword} (tried: ${keywords.join(", ")})`,
  );
}
