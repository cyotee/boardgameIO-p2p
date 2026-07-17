# @cyotee/boardgameio-p2p

Peer-to-peer multiplayer transport for [boardgame.io](https://boardgame.io).

Fork of the experimental [`@boardgame.io/p2p`](https://github.com/boardgameio/p2p) package with two connection modes:

| Mode | API | Connection |
|------|-----|------------|
| **PeerJS** (upstream) | `P2P({ isHost })` | PeerJS peer IDs / PeerServer |
| **Channel** (ManaMesh) | `P2PMultiplayer({ connection, role, ... })` | Injected `P2PChannel` (join-code WebRTC, etc.) |

## Install

```bash
npm install @cyotee/boardgameio-p2p boardgame.io
```

## Channel mode (recommended for ManaMesh)

Use when peers already share a data channel (e.g. join-code WebRTC):

```ts
import { Client } from "boardgame.io/client";
// Prefer /channel so PeerJS is not required for this path
import { P2PMultiplayer, type P2PChannel } from "@cyotee/boardgameio-p2p/channel";

// `connection` implements P2PChannel: send, isConnected, events
const multiplayer = P2PMultiplayer({
  connection, // JoinCodeConnection or any P2PChannel
  role: "host", // or "guest"
  playerID: "0",
  matchID: "match-1",
  numPlayers: 2,
});

const client = Client({
  game: MyGame,
  multiplayer,
});
```

### `P2PChannel`

```ts
interface P2PChannel {
  send(data: string): void;
  isConnected(): boolean;
  events: {
    onMessage: (data: string) => void;
    onConnectionStateChange: (state: ConnectionState) => void;
  };
}
```

Join-code discovery stays in the app; only the **boardgame.io transport** lives here.

## PeerJS mode (upstream)

```ts
import { P2P } from "@cyotee/boardgameio-p2p";

Client({
  game: MyGame,
  matchID: "random-id",
  playerID: "0",
  multiplayer: P2P({ isHost: true }),
});
```

## Build

```bash
yarn workspace @cyotee/boardgameio-p2p build
```

## License

MIT (upstream boardgame.io p2p authors + cyotee extensions)
