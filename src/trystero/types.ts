import type { P2PChannel } from "../channel";

/** Protocol version for Manamesh handshake over Trystero. */
export const MANAMESH_HANDSHAKE_V = 1 as const;

export type ManameshHandshake = {
  v: typeof MANAMESH_HANDSHAKE_V;
  role: "host" | "guest";
  matchID: string;
  gameId: string;
  seat?: string;
  clientBuild?: string;
};

export type TrysteroTableRole = "host" | "guest";

export type JoinTrysteroTableOpts = {
  appId: string;
  roomCode: string;
  password?: string;
  role: TrysteroTableRole;
  gameId: string;
  matchID: string;
  maxPlayers: number;
  /** ICE / TURN servers for hard NAT */
  turnConfig?: RTCIceServer[];
  connectTimeoutMs?: number;
  clientBuild?: string;
  /**
   * Injectable joinRoom for tests (no live Nostr).
   * Signature mirrors trystero joinRoom(config, roomId, opts?).
   */
  joinRoomImpl?: JoinRoomFn;
};

export type TrysteroTableSession = {
  role: TrysteroTableRole;
  playerID: string;
  /** boardgame.io playerID → trystero peerId */
  seatMap: Map<string, string>;
  /** Guest: channel to host. Host may leave undefined. */
  connection?: P2PChannel;
  /** Host: one channel per guest playerID */
  hostConnections?: Map<string, P2PChannel>;
  leave: () => void;
  /** Live roster of seated playerIDs (host + guests) */
  getSeatedPlayerIDs: () => string[];
  onRosterChange?: (seated: string[]) => void;
};

/** Minimal Trystero room surface we use */
export type TrysteroAction<T> = {
  send: (
    data: T,
    opts?: { target?: string },
  ) => Promise<unknown> | unknown;
  onProgress?: unknown;
  onComplete?: unknown;
};

export type TrysteroRoom = {
  makeAction: <T = unknown>(
    name: string,
  ) => {
    send: (
      data: T,
      opts?: { target?: string },
    ) => Promise<unknown> | unknown;
    onProgress?: ((...args: unknown[]) => void) | null;
  } & {
    // trystero uses assignment for handlers
    onProgress?: unknown;
  };
  leave: () => void;
  getPeers?: () => Map<string, unknown>;
  onPeerJoin?: ((peerId: string) => void) | null;
  onPeerLeave?: ((peerId: string) => void) | null;
};

// Trystero mutates action with onProgress/onComplete as properties
export type TrysteroActionHandle<T> = {
  send: (
    data: T,
    opts?: { target?: string },
  ) => Promise<unknown> | unknown;
  onProgress: ((percent: number, peerId: string, metadata?: unknown) => void) | null;
  // Message handler — assigned as property in real trystero
  [key: string]: unknown;
};

export type JoinRoomFn = (
  config: {
    appId: string;
    password?: string;
    turnConfig?: RTCIceServer[];
  },
  roomId: string,
  opts?: {
    onJoinError?: (details: unknown) => void;
  },
) => TrysteroRoom & {
  // makeAction returns object with assignable on* handlers
  makeAction: <T = unknown>(name: string) => {
    send: (
      data: T,
      opts?: { target?: string },
    ) => Promise<unknown> | unknown;
    onProgress: ((...args: unknown[]) => void) | null;
  };
};
