import { ElevenLabsClient } from "elevenlabs";
import { v2 as cloudinary } from "cloudinary";
import { DEFAULT_VOICE_ID } from "./constants.js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

function resolveVoiceId(voice) {
  if (voice && /^[a-zA-Z0-9]{15,}$/.test(voice)) {
    return voice;
  }
  return DEFAULT_VOICE_ID;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Apply measured voice duration to a clip (replaces Claude's estimated duration).
 */
export function applyVoiceTimingToClip(clip, { voice_url, voice_duration }) {
  const duration = Number(voice_duration);

  return {
    ...clip,
    voice_url,
    voice_duration: duration,
    duration,
    trim_end: duration,
    trim_start: Number(clip.trim_start ?? 0),
  };
}

/**
 * @returns {Promise<{ voice_url: string, voice_duration: number }>}
 */
export async function generateVoiceover(narration, voice, videoId, sceneIndex) {
  const voiceId = resolveVoiceId(voice);

  console.log("[voice] Generating ElevenLabs voiceover", {
    videoId,
    sceneIndex,
    voiceId,
    narrationLength: narration.length,
  });

  const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
    text: narration,
    model_id: "eleven_multilingual_v2",
    output_format: "mp3_44100_128",
  });

  const audioBuffer = await streamToBuffer(audioStream);

  console.log("[voice] Uploading audio to Cloudinary", {
    videoId,
    sceneIndex,
    bytes: audioBuffer.length,
  });

  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        folder: `autopilot/${videoId}/audio`,
        public_id: `scene_${sceneIndex}`,
        format: "mp3",
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      },
    );
    uploadStream.end(audioBuffer);
  });

  if (uploadResult.duration == null) {
    throw new Error(
      "Cloudinary did not return audio duration for voiceover upload",
    );
  }

  const voice_duration = Number(uploadResult.duration);

  console.log("[voice] Voiceover duration from Cloudinary", {
    videoId,
    sceneIndex,
    voice_duration,
    trim_end: voice_duration,
    url: uploadResult.secure_url,
  });

  return {
    voice_url: uploadResult.secure_url,
    voice_duration,
  };
}
