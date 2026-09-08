// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createSafeLocalAudioBlob,
  LocalAudioImportError,
  maxLocalAudioBytes,
} from "./localAudio";

function waveBytes() {
  const bytes = new Uint8Array(46);
  const header = new DataView(bytes.buffer);
  bytes.set([82, 73, 70, 70]);
  header.setUint32(4, 38, true);
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 8000, true);
  header.setUint32(28, 16000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  bytes.set([100, 97, 116, 97], 36);
  header.setUint32(40, 2, true);
  return bytes;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

describe("本地音频导入边界", () => {
  it.each([
    ["page.html", "text/html", "<html><script>alert(1)</script></html>"],
    ["image.svg", "image/svg+xml", '<svg onload="alert(1)"></svg>'],
    ["song.mp3", "text/html", "<html><script>alert(1)</script></html>"],
    ["song.ogg", "image/svg+xml", '<svg onload="alert(1)"></svg>'],
    ["song.mp3", "audio/mpeg", "<html><script>alert(1)</script></html>"],
    ["song.wav", "audio/wav", '<svg onload="alert(1)"></svg>'],
    ["song.flac", "", '<svg onload="alert(1)"></svg>'],
  ])("拒绝网页、SVG 和伪造音频：%s %s", async (name, type, body) => {
    await expect(
      createSafeLocalAudioBlob(new File([body], name, { type })),
    ).rejects.toBeInstanceOf(LocalAudioImportError);
  });

  it.each([
    "image/svg+xml",
    "application/octet-stream",
    "audio/mpeg",
    "audio/wav; charset=utf-8",
  ])("即使文件头有效也拒绝错误 MIME：%s", async (type) => {
    await expect(
      createSafeLocalAudioBlob(new File([waveBytes()], "song.wav", { type })),
    ).rejects.toThrow("文件类型与音频格式不符");
  });

  it("读取前拒绝超大文件，不分配整首歌曲的额外缓冲", async () => {
    const file = new File([waveBytes()], "song.wav", { type: "audio/wav" });
    Object.defineProperty(file, "size", { value: maxLocalAudioBytes + 1 });
    const read = vi.spyOn(file, "slice");
    await expect(createSafeLocalAudioBlob(file)).rejects.toThrow("100 MiB");
    expect(read).not.toHaveBeenCalled();
  });

  it("拒绝空文件和截断文件", async () => {
    await expect(
      createSafeLocalAudioBlob(new File([], "song.wav")),
    ).rejects.toThrow("空的");
    await expect(
      createSafeLocalAudioBlob(new File(["ID3"], "song.mp3")),
    ).rejects.toThrow("不完整");
  });

  it.each(["audio/wav", "audio/x-wav", "", "AUDIO/WAV"])(
    "合法 WAV 保留音频字节，并强制使用安全 MIME：%s",
    async (type) => {
      const bytes = waveBytes();
      const file = new File([bytes], "我的歌曲.WAV", { type });
      const slice = vi.spyOn(file, "slice");
      const result = await createSafeLocalAudioBlob(file);
      expect(result).not.toBe(file);
      expect(result.type).toBe("audio/wav");
      expect(result.size).toBe(file.size);
      expect(new Uint8Array(await readBlob(result))).toEqual(bytes);
      expect(slice).toHaveBeenCalledExactlyOnceWith(0, 512);
    },
  );

  it.each(["audio/mpeg", "audio/mp3", ""])(
    "允许 MP3 帧头并固定 MIME：%s",
    async (type) => {
      const bytes = new Uint8Array(128);
      bytes.set([0xff, 0xfb, 0x90, 0]);
      const blob = await createSafeLocalAudioBlob(
        new File([bytes], "track.mp3", { type }),
      );
      expect(blob.type).toBe("audio/mpeg");
    },
  );

  it("允许含 ID3 标签的 MP3", async () => {
    const bytes = new Uint8Array(128);
    bytes.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
    const blob = await createSafeLocalAudioBlob(new File([bytes], "track.mp3"));
    expect(blob.type).toBe("audio/mpeg");
  });

  it.each(["ogg", "opus"])("允许 Ogg Opus 音频容器：%s", async (extension) => {
    const bytes = new Uint8Array(64);
    bytes.set([79, 103, 103, 83]);
    bytes[26] = 1;
    bytes[27] = 19;
    bytes.set([79, 112, 117, 115, 72, 101, 97, 100], 28);
    const blob = await createSafeLocalAudioBlob(
      new File([bytes], `track.${extension}`),
    );
    expect(blob.type).toBe("audio/ogg");
  });

  it("仅允许 Ogg 的音频标识，拒绝视频和未知容器", async () => {
    const bytes = new Uint8Array(64);
    bytes.set([79, 103, 103, 83]);
    bytes[26] = 1;
    bytes[27] = 30;
    bytes.set([1, 118, 111, 114, 98, 105, 115], 28);
    const blob = await createSafeLocalAudioBlob(new File([bytes], "track.ogg"));
    expect(blob.type).toBe("audio/ogg");
    bytes.set([0x80, 116, 104, 101, 111, 114, 97], 28);
    await expect(
      createSafeLocalAudioBlob(new File([bytes], "video.ogg")),
    ).rejects.toThrow("内容与格式不符");
  });

  it("允许带 STREAMINFO 的 FLAC", async () => {
    const bytes = new Uint8Array(64);
    bytes.set([102, 76, 97, 67, 0x80, 0, 0, 34]);
    const blob = await createSafeLocalAudioBlob(
      new File([bytes], "track.flac", { type: "audio/x-flac" }),
    );
    expect(blob.type).toBe("audio/flac");
  });

  it("文件读取失败时只返回安全错误文案", async () => {
    const reader = vi
      .spyOn(FileReader.prototype, "readAsArrayBuffer")
      .mockImplementation(function (this: FileReader) {
        this.dispatchEvent(new Event("error"));
      });
    try {
      await expect(
        createSafeLocalAudioBlob(new File([waveBytes()], "private-song.wav")),
      ).rejects.toThrow("无法读取这首歌曲，请重新选择本地文件。");
    } finally {
      reader.mockRestore();
    }
  });
});
