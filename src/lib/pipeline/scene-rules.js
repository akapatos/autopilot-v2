/** Spoken pacing: words per minute for narration timing. */
export const WORDS_PER_MINUTE = 130;

export const MIN_SCENE_DURATION = 4;
export const MAX_SCENE_DURATION = 15;

const KEYWORD_MODIFIERS = [
  "cinematic",
  "aerial",
  "close up",
  "documentary",
  "detail",
  "wide shot",
];

export function wordCount(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Exact narration duration at 130 WPM (no estimation).
 */
export function durationFromWordCount(narration) {
  const n = wordCount(narration);
  const raw = (n / WORDS_PER_MINUTE) * 60;
  return Math.round(raw * 10) / 10;
}

function applyWordDuration(scene) {
  return {
    ...scene,
    duration: durationFromWordCount(scene.narration),
  };
}

function splitIntoSentences(narration) {
  const trimmed = String(narration || "").trim();
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  if (parts?.length) {
    return parts.map((s) => s.trim()).filter(Boolean);
  }

  return [trimmed];
}

function splitNarrationInHalf(narration) {
  const sentences = splitIntoSentences(narration);

  if (sentences.length >= 2) {
    const totalWords = wordCount(narration);
    let bestIdx = 1;
    let bestDiff = Infinity;

    for (let i = 1; i < sentences.length; i++) {
      const firstWords = wordCount(sentences.slice(0, i).join(" "));
      const diff = Math.abs(firstWords - (totalWords - firstWords));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    return [
      sentences.slice(0, bestIdx).join(" ").trim(),
      sentences.slice(bestIdx).join(" ").trim(),
    ];
  }

  const words = narration.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return [narration, ""];
  }

  const mid = Math.ceil(words.length / 2);
  return [
    words.slice(0, mid).join(" "),
    words.slice(mid).join(" "),
  ];
}

export function diversifyVisualKeyword(keyword, partIndex = 0) {
  const base = String(keyword || "documentary b-roll").trim();
  const mod = KEYWORD_MODIFIERS[partIndex % KEYWORD_MODIFIERS.length];
  if (base.toLowerCase().includes(mod.toLowerCase())) {
    const alt = KEYWORD_MODIFIERS[(partIndex + 1) % KEYWORD_MODIFIERS.length];
    return `${base} ${alt}`.trim();
  }
  return `${base} ${mod}`.trim();
}

function pickMoreSpecificKeyword(a, b) {
  const sa = String(a || "").trim();
  const sb = String(b || "").trim();
  if (!sa) return sb;
  if (!sb) return sa;
  return sa.split(/\s+/).length >= sb.split(/\s+/).length ? sa : sb;
}

function splitScene(scene, sceneIndex) {
  const [narrationA, narrationB] = splitNarrationInHalf(scene.narration);

  if (!narrationB) {
    return [applyWordDuration(scene)];
  }

  const sceneA = applyWordDuration({
    ...scene,
    narration: narrationA,
  });

  const sceneB = applyWordDuration({
    ...scene,
    narration: narrationB,
    visualKeyword: diversifyVisualKeyword(scene.visualKeyword, sceneIndex + 1),
    visualDescription: scene.visualDescription
      ? `${scene.visualDescription} Alternate angle for second half of beat.`
      : "",
    compositionType: "stock",
    compositionProps: null,
  });

  if (sceneIndex === 0) {
    sceneA.compositionType = "title-card";
    sceneA.compositionProps = scene.compositionProps;
    sceneB.compositionType = "stock";
    sceneB.compositionProps = null;
  }

  return [sceneA, sceneB];
}

function mergeScenes(first, second, firstIndex) {
  const mergedNarration = `${first.narration} ${second.narration}`.trim();
  const merged = {
    ...second,
    narration: mergedNarration,
    visualKeyword: pickMoreSpecificKeyword(
      first.visualKeyword,
      second.visualKeyword,
    ),
    visualDescription:
      second.visualDescription || first.visualDescription || "",
    productionNotes: [first.productionNotes, second.productionNotes]
      .filter(Boolean)
      .join(" "),
  };

  if (firstIndex === 0 && first.compositionType === "title-card") {
    merged.compositionType = "title-card";
    merged.compositionProps =
      first.compositionProps ?? second.compositionProps ?? null;
  }

  return applyWordDuration(merged);
}

function alignTotalToTarget(scenes, targetSeconds) {
  if (!scenes.length || !targetSeconds) {
    return scenes;
  }

  const sum = scenes.reduce((acc, s) => acc + s.duration, 0);
  const diff = Math.round((targetSeconds - sum) * 10) / 10;

  if (Math.abs(diff) < 0.05) {
    return scenes;
  }

  const lastIdx = scenes.length - 1;
  const adjusted = Math.round((scenes[lastIdx].duration + diff) * 10) / 10;

  if (adjusted >= MIN_SCENE_DURATION && adjusted <= MAX_SCENE_DURATION) {
    const out = [...scenes];
    out[lastIdx] = { ...out[lastIdx], duration: adjusted };
    return out;
  }

  return scenes;
}

/**
 * Enforce 4–15s scenes by splitting long narration and merging short beats.
 * Duration always derived from word count at 130 WPM.
 */
export function enforceSceneRules(scenes, targetSeconds) {
  let result = scenes.map(applyWordDuration);

  const MAX_PASSES = 50;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    const afterSplit = [];

    for (let i = 0; i < result.length; i++) {
      const scene = result[i];
      const dur = durationFromWordCount(scene.narration);

      if (dur > MAX_SCENE_DURATION) {
        afterSplit.push(...splitScene(scene, i));
        changed = true;
      } else {
        afterSplit.push(applyWordDuration(scene));
      }
    }

    result = afterSplit;

    let i = 0;
    while (i < result.length) {
      const dur = durationFromWordCount(result[i].narration);

      if (dur < MIN_SCENE_DURATION && result.length > 1) {
        if (i < result.length - 1) {
          result[i + 1] = mergeScenes(result[i], result[i + 1], i);
          result.splice(i, 1);
        } else {
          result[i - 1] = mergeScenes(result[i - 1], result[i], i - 1);
          result.pop();
        }
        changed = true;
        continue;
      }

      result[i] = applyWordDuration(result[i]);
      i++;
    }

    if (!changed) {
      break;
    }
  }

  result = result.map(applyWordDuration);
  result = ensureUniqueVisualKeywords(result);
  return alignTotalToTarget(result, targetSeconds);
}

function ensureUniqueVisualKeywords(scenes) {
  const used = new Set();

  return scenes.map((scene, index) => {
    let keyword = String(scene.visualKeyword || "").trim();
    const key = keyword.toLowerCase();

    if (!keyword || used.has(key)) {
      keyword = diversifyVisualKeyword(
        keyword || "documentary footage",
        index,
      );
    }

    let unique = keyword;
    let attempt = 0;
    while (used.has(unique.toLowerCase()) && attempt < 10) {
      unique = diversifyVisualKeyword(keyword, index + attempt);
      attempt++;
    }

    used.add(unique.toLowerCase());
    return { ...scene, visualKeyword: unique };
  });
}
