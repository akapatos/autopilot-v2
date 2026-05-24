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
 * Generate voiceover and upload to Cloudinary for assembly.
 * @returns {Promise<string>} HTTPS URL of the uploaded audio
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

  console.log("[voice] Voiceover uploaded", {
    videoId,
    sceneIndex,
    url: uploadResult.secure_url,
    publicId: uploadResult.public_id,
  });

  return uploadResult.secure_url;
}
