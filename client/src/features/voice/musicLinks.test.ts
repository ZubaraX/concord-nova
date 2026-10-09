import { describe, expect, it } from "vitest";
import { linkKind, parsePlaylist, vkHome, yandexEmbed } from "./musicLinks";

describe("Yandex Music links → the official player", () => {
  it("a track, an album and a playlist each get the widget Yandex itself offers", () => {
    expect(yandexEmbed("https://music.yandex.ru/album/41735634/track/150614117?utm_source=desktop&utm_medium=copy_link")).toEqual({ src: "https://music.yandex.ru/iframe/album/41735634/track/150614117", height: 244 });
    expect(yandexEmbed("https://music.yandex.ru/album/41735634")).toEqual({ src: "https://music.yandex.ru/iframe/album/41735634", height: 450 });
    expect(yandexEmbed("https://music.yandex.com/users/someone/playlists/1003")).toEqual({ src: "https://music.yandex.com/iframe/playlist/someone/1003", height: 450 });
  });
  it("anything else stays a link", () => {
    expect(yandexEmbed("https://music.yandex.ru/artist/24921667")).toBeNull();
    expect(yandexEmbed("https://evil.example/album/1/track/2")).toBeNull();
    expect(yandexEmbed("not a url")).toBeNull();
  });
});

describe("playlist files", () => {
  it("an .m3u gives its web addresses, with the titles it names", () => {
    const m3u = "#EXTM3U\n#EXTINF:123,Artist - Song\nhttps://cdn.example/song.mp3\nC:\Music\local.mp3\n\n#EXTINF:-1,Live\nhttp://radio.example:8000/stream\n";
    expect(parsePlaylist(m3u)).toEqual({
      urls: [
        { url: "https://cdn.example/song.mp3", title: "Artist - Song" },
        { url: "http://radio.example:8000/stream", title: "Live" },
      ],
      local: 1,
    });
  });
  it("a .pls too", () => {
    const pls = "[playlist]\nFile1=https://cdn.example/a.mp3\nTitle1=A\nFile2=/home/me/b.mp3\nNumberOfEntries=2\n";
    expect(parsePlaylist(pls)).toEqual({ urls: [{ url: "https://cdn.example/a.mp3", title: "A" }], local: 1 });
  });
});

describe("what a shared link is, for its tile", () => {
  it("tracks, albums, playlists and artists of Yandex and VK", () => {
    expect(linkKind("https://music.yandex.ru/album/41735634/track/150614117")).toBe("track");
    expect(linkKind("https://music.yandex.ru/album/41735634")).toBe("album");
    expect(linkKind("https://music.yandex.ru/users/someone/playlists/1003")).toBe("playlist");
    expect(linkKind("https://music.yandex.ru/artist/24921667")).toBe("artist");
    expect(linkKind("https://vk.com/audio_playlist-147845620_2949")).toBe("playlist");
    expect(linkKind("https://vk.com/music/playlist/-147845620_2949")).toBe("playlist");
    expect(linkKind("https://vk.com/audio?z=audio-2001_123")).toBe("track");
    expect(linkKind("https://vk.com/audios123")).toBe("other");
  });
});

describe("VK links open at vk.ru", () => {
  it("vk.com, www and m. move over; everything else stays", () => {
    expect(vkHome("https://vk.com/audio_playlist-147845620_2949")).toBe("https://vk.ru/audio_playlist-147845620_2949");
    expect(vkHome("https://www.vk.com/music/playlist/-1_2?x=1")).toBe("https://vk.ru/music/playlist/-1_2?x=1");
    expect(vkHome("https://m.vk.com/audio")).toBe("https://m.vk.ru/audio");
    expect(vkHome("https://vk.ru/audio")).toBe("https://vk.ru/audio");
    expect(vkHome("https://notvk.com/a")).toBe("https://notvk.com/a");
  });
});
