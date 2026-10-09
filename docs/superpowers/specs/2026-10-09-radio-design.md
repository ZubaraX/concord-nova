# Radio in voice calls — design

Date: 2026-10-09. Status: approved in chat, spec under review.

## Goal

A voice channel (or a private call) gets a shared radio: the people in the call
add tracks to one queue, everyone in the call hears the same track at the same
moment, and each listener sets their own radio volume.

Success: two people in a call hear the same song in sync (within ~0.2 s), either
can add, pause and skip, and turning one's own slider changes only one's own
volume. Nothing is stored on the server.

## Out of scope

- Signing in with Yandex Music (QR) or VK Music, and playing their catalogues:
  neither offers third-party playback (Yandex Music has no public API; VK closed
  audio to apps in 2016). Unofficial access breaks and risks the users' accounts.
- A personal music library: with nothing stored on the server, a track exists
  only while it is queued.

## What people see

- **"Радио" button** in the call controls. It opens a panel:
  - *Now playing*: title, who added it, progress, **pause/resume** and **skip**;
  - *Your volume*: a slider (0–100 %, kept on this device). Deafening yourself
    silences the radio too;
  - *Queue*: the next tracks with who added them; **remove** on your own
    (moderators — "move members" — remove any in servers);
  - *Add*: files (several at once, or dropped onto the panel) or a link;
  - *Shared links*: Yandex Music / VK links people shared — a card that opens the
    track in its app. They are not played for everyone and never block the queue.
- **In the sidebar**, under a voice channel with music: "🎵 <title>".

## Rules

- Anyone connected to the channel adds, pauses/resumes and skips.
- Limits: a file up to 50 MB, a track up to 20 min, up to 50 tracks queued, up to
  20 shared links kept (oldest dropped).
- When someone leaves the call, their tracks that haven't started leave the queue;
  their current track keeps playing for those who already have it.
- When the last person leaves, the radio of that channel is gone.

## How it works

### Server: the queue only (in memory)

`server/src/state/radio.ts` keeps, per channel:

```
items:   { id, kind: "file" | "link", title, duration (s), addedBy, url? }[]
current: { itemId, startedAt (server ms), pausedAt (position ms) | null } | null
links:   { id, service: "yandex" | "vk", url, title?, addedBy, at }[]
```

- HTTP (`server/src/routes/radio.ts`), all requiring the caller to be connected
  to that channel's call (`voice` state):
  - `GET /api/channels/:id/radio` — the state;
  - `POST /api/channels/:id/radio/items` `{ kind, title, duration, url? }` —
    validated (lengths, http(s) for links, limits); a Yandex/VK URL goes to `links`;
  - `DELETE /api/channels/:id/radio/items/:itemId` — own, or a moderator;
  - `POST .../radio/skip` `{ itemId }` — only if it is still current (two people
    pressing skip at once skip one track);
  - `POST .../radio/pause` / `.../radio/resume`.
- The server starts the first item when the queue was idle, and moves on by
  itself when the current one's duration has passed (+1.5 s), with a timer per
  channel.
- Voice leave hook: drop the leaver's not-started items; drop the whole state
  when the channel is empty.
- Every change dispatches `RADIO_STATE { channelId, items, current, links,
  serverNow }` to everyone who can see the channel (`toChannel`), so the sidebar
  line works for people outside the call too.

### Files: from the adder's app, through the call

- The adder's app keeps the picked `File`s (nothing is uploaded).
- When one of its items becomes **current or next**, it sends that file to
  everyone in the call over a LiveKit byte stream (topic `nova-radio`,
  attribute `itemId`) — LiveKit relays it, nothing is stored. Someone who joins
  later receives the current and next files from their adders.
- Listeners hold received files as object URLs keyed by item id and release them
  when the item is gone — at most two at a time.
- The duration is read from the file by the adder before adding.

### Links

- A direct link to an audio file: the adder's app checks it plays (and reads its
  duration) before adding; each app then plays it straight from the internet.
- A Yandex Music or VK link (by host): goes to *shared links* as a card.

### Playback, in sync

- `client/src/features/voice/radio.ts`: the state from `RADIO_STATE` and the
  GET on joining; one `HTMLAudioElement` while connected to that call, playing
  the current item's object URL or link.
- Position = (server now − `startedAt`); server now = local time + the offset
  learned from `serverNow` in each `RADIO_STATE` (the largest seen recently, as
  delays only make it look smaller). Seek when off by more than 0.3 s; a file
  that arrives late starts at the right position.
- Volume = own radio volume × output volume; 0 while deafened; the output device
  follows the call's.
- Paused: the element pauses at `pausedAt`.

### Interface

- `RadioPanel.tsx` (popover from the call controls), the button in `VoiceStage`
  controls, the sidebar line in the channel list.
- Diagnostic log: added/started/skipped/failed to play, and file sends.

## Testing

- Server (vitest): add/remove/skip/pause/resume, limits, moderator removal, the
  leaver's items dropped, state dropped when the channel empties, auto-advance.
- e2e:
  - Alice adds a file; Bob's player plays the same position within 0.5 s;
  - Bob's slider changes his element's volume only;
  - a direct link (served by the test) plays for both;
  - Carol joins mid-track and plays from the right position;
  - skip and pause reach everyone;
  - Alice leaves: her queued tracks are gone;
  - a Yandex link shows as a card, not in the queue.
