import axios from "axios";

function pickPexelsVideoUrl(video) {
  const files = video?.video_files || [];
  const mp4Files = files.filter(
    (f) => f.file_type === "video/mp4" || f.link?.endsWith(".mp4"),
  );
  const sorted = [...mp4Files].sort(
    (a, b) => (b.height || 0) - (a.height || 0),
  );
  const best = sorted.find((f) => (f.height || 0) <= 1080) || sorted[0];
  return best?.link || files[0]?.link;
}

function pickPixabayVideoUrl(hit) {
  const videos = hit?.videos;
  if (!videos) return null;
  return (
    videos.large?.url ||
    videos.medium?.url ||
    videos.small?.url ||
    videos.tiny?.url
  );
}

export async function fetchStockVideo(visualKeyword) {
  const query = encodeURIComponent(visualKeyword);
  console.log("[stock] Searching Pexels", { visualKeyword });

  try {
    const pexelsRes = await axios.get(
      `https://api.pexels.com/videos/search?query=${query}&per_page=5&orientation=landscape`,
      {
        headers: { Authorization: process.env.PEXELS_API_KEY },
        timeout: 30000,
      },
    );

    const pexelsVideo = pexelsRes.data?.videos?.[0];
    const pexelsUrl = pickPexelsVideoUrl(pexelsVideo);

    if (pexelsUrl) {
      console.log("[stock] Pexels clip found", {
        visualKeyword,
        url: pexelsUrl,
        id: pexelsVideo?.id,
      });
      return { file_url: pexelsUrl, source: "pexels" };
    }

    console.log("[stock] No Pexels results; trying Pixabay", { visualKeyword });
  } catch (error) {
    console.warn("[stock] Pexels search failed", {
      visualKeyword,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  console.log("[stock] Searching Pixabay", { visualKeyword });

  const pixabayRes = await axios.get("https://pixabay.com/api/videos/", {
    params: {
      key: process.env.PIXABAY_API_KEY,
      q: visualKeyword,
      per_page: 5,
    },
    timeout: 30000,
  });

  const pixabayHit = pixabayRes.data?.hits?.[0];
  const pixabayUrl = pickPixabayVideoUrl(pixabayHit);

  if (!pixabayUrl) {
    throw new Error(`No stock footage found for keyword: ${visualKeyword}`);
  }

  console.log("[stock] Pixabay clip found", {
    visualKeyword,
    url: pixabayUrl,
    id: pixabayHit?.id,
  });

  return { file_url: pixabayUrl, source: "pixabay" };
}
