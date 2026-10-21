// Opens a video file with mediabunny and reports what the app needs to know. Works in the browser and in Node.
import { Input, ALL_FORMATS, BlobSource } from 'mediabunny';

/** @param {Blob} file */
export async function probe(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');

  const [stats, durationSec, firstTimestamp, audioTrack, format] = await Promise.all([
    track.computePacketStats(),
    track.computeDuration(),
    track.getFirstTimestamp(),
    input.getPrimaryAudioTrack(),
    input.getFormat(),
  ]);

  return {
    input,
    track,
    meta: {
      containerName: format.name, // e.g. "MP4", "QuickTime File Format (.mov)", "WebM"
      codec: track.codec, // 'avc' | 'hevc' | 'vp9' | 'av1' ...
      width: track.displayWidth, // after rotation
      height: track.displayHeight,
      rotation: track.rotation, // clockwise degrees that the file asks players to apply
      fps: stats.averagePacketRate,
      frameCount: stats.packetCount,
      bitrate: stats.averageBitrate,
      durationSec,
      firstTimestamp,
      hasAudio: !!audioTrack,
    },
  };
}
