export const maxLocalAudioBytes = 100 * 1024 * 1024;
export const localAudioAccept = ".mp3,.wav,.ogg,.opus,.flac";

export class LocalAudioImportError extends Error {}

function hasHeader(bytes: Uint8Array, text: string, offset = 0) {
  return Array.from(text).every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

function readHeader(file: File): Promise<Uint8Array> {
  // FileReader also works on older WebView2 versions. Never read the whole song.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const failed = () =>
      reject(
        new LocalAudioImportError("无法读取这首歌曲，请重新选择本地文件。"),
      );
    reader.onerror = failed;
    reader.onabort = failed;
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        failed();
      }
    };
    reader.readAsArrayBuffer(file.slice(0, 512));
  });
}

export async function createSafeLocalAudioBlob(file: File): Promise<Blob> {
  if (file.size === 0) {
    throw new LocalAudioImportError("这份文件是空的，请选择一首完整的歌曲。");
  }
  if (file.size > maxLocalAudioBytes) {
    throw new LocalAudioImportError(
      "歌曲文件不能超过 100 MiB，请选择较小的文件。",
    );
  }
  const extension = file.name.split(".").pop()?.toLowerCase();
  const mime = file.type.toLowerCase();
  const expectedTypes: Record<string, readonly string[]> = {
    mp3: ["audio/mpeg", "audio/mp3"],
    wav: ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"],
    ogg: ["audio/ogg"],
    opus: ["audio/ogg", "audio/opus"],
    flac: ["audio/flac", "audio/x-flac"],
  };
  const allowedTypes =
    extension && Object.prototype.hasOwnProperty.call(expectedTypes, extension)
      ? expectedTypes[extension]
      : undefined;
  if (!allowedTypes) {
    throw new LocalAudioImportError(
      "目前支持 MP3、WAV、OGG、Opus 和 FLAC 音频文件。",
    );
  }
  // Windows may provide no MIME; accept that only after validating the header.
  if (mime && !allowedTypes.includes(mime)) {
    throw new LocalAudioImportError(
      "文件类型与音频格式不符，请勿导入网页、图片或改名文件。",
    );
  }
  const bytes = await readHeader(file);
  if (bytes.length < 12) {
    throw new LocalAudioImportError("音频文件不完整或格式不符，请换一首试试。");
  }
  // Do not preserve File.type: only these literal, non-executable audio MIME
  // types may reach an object URL. Header checks reject renamed HTML/SVG files;
  // the media decoder still decides whether an audio stream is playable.
  switch (extension) {
    case "mp3": {
      const id3 =
        hasHeader(bytes, "ID3") &&
        bytes[3] >= 2 &&
        bytes[3] <= 4 &&
        bytes.slice(6, 10).every((byte) => byte < 128);
      const frame =
        bytes[0] === 0xff &&
        (bytes[1] & 0xe0) === 0xe0 &&
        (bytes[1] & 0x18) !== 0x08 &&
        (bytes[1] & 0x06) === 0x02 &&
        (bytes[2] & 0xf0) !== 0 &&
        (bytes[2] & 0xf0) !== 0xf0 &&
        (bytes[2] & 0x0c) !== 0x0c;
      if (id3 || frame) return new Blob([file], { type: "audio/mpeg" });
      break;
    }
    case "wav":
      if (hasHeader(bytes, "RIFF") && hasHeader(bytes, "WAVE", 8)) {
        return new Blob([file], { type: "audio/wav" });
      }
      break;
    case "ogg":
    case "opus": {
      const payload = 27 + bytes[26];
      const opus = hasHeader(bytes, "OpusHead", payload);
      const vorbis =
        bytes[payload] === 1 && hasHeader(bytes, "vorbis", payload + 1);
      if (
        hasHeader(bytes, "OggS") &&
        bytes[4] === 0 &&
        bytes[26] > 0 &&
        (opus || (extension === "ogg" && vorbis))
      ) {
        return new Blob([file], { type: "audio/ogg" });
      }
      break;
    }
    case "flac":
      if (
        hasHeader(bytes, "fLaC") &&
        bytes.length >= 42 &&
        (bytes[4] & 0x7f) === 0 &&
        bytes[5] === 0 &&
        bytes[6] === 0 &&
        bytes[7] === 34
      ) {
        return new Blob([file], { type: "audio/flac" });
      }
  }
  throw new LocalAudioImportError(
    "音频文件内容与格式不符，请选择未改名且完整的歌曲文件。",
  );
}
