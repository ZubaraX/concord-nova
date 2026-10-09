import { describe, expect, it } from "vitest";
import { parsePlaylist, yandexEmbed } from "./musicLinks";

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
