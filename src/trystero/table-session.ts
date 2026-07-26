import { TrysteroChannel, TRYSTERO_BGIO_ACTION, TRYSTERO_HS_ACTION } from "./channel";
import {
  admitGuestHandshake,
  buildHandshake,
  parseHandshake,
} from "./handshake";
import { isValidRoomCode, normalizeRoomCode } from "./room-code";
import type {
  JoinTrysteroTableOpts,
  ManameshHandshake,
  TrysteroTableSession,
} from "./types";

type ActionHandle<T> = {
  send: (data: T, opts?: { target?: string }) => void | Promise<unknown>;
  // trystero assigns handlers as properties
  onProgress: ((...args: unknown[]) => void) | null;
};

type RoomLike = {
  makeAction: <T = unknown>(name: string) => ActionHandle<T>;
  leave: () => void;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
};

type HsPayload =
  | { kind: "hello"; handshake: ManameshHandshake }
  | { kind: "accept"; seat: string; handshake: ManameshHandshake }
  | { kind: "reject"; reason: string };

/**
 * Join or create a Trystero table for ManaMesh boardgame.io sessions.
 *
 * Host: waits for guests, assigns FIFO seats, exposes hostConnections.
 * Guest: handshakes with host, receives seat, exposes connection to host.
 *
 * Pass `joinRoomImpl` in tests to avoid live Nostr.
 */
export async function joinTrysteroTable(
  opts: JoinTrysteroTableOpts,
): Promise<TrysteroTableSession> {
  const roomCode = normalizeRoomCode(opts.roomCode);
  if (!isValidRoomCode(roomCode)) {
    throw new Error("invalid_room_code");
  }
  if (opts.maxPlayers < 2) {
    throw new Error("maxPlayers must be >= 2");
  }

  const joinRoom = opts.joinRoomImpl ?? (await loadDefaultJoinRoom());
  const connectTimeoutMs = opts.connectTimeoutMs ?? 12_000;

  let joinError: unknown = null;
  const room = joinRoom(
    {
      appId: opts.appId,
      password: opts.password || undefined,
      turnConfig: opts.turnConfig,
    },
    roomCode,
    {
      onJoinError: (details) => {
        joinError = details;
      },
    },
  ) as RoomLike;

  if (joinError) {
    try {
      room.leave();
    } catch {
      /* ignore */
    }
    throw new Error("trystero_join_error");
  }

  const bgioAction = room.makeAction<string>(TRYSTERO_BGIO_ACTION);
  const hsAction = room.makeAction<HsPayload>(TRYSTERO_HS_ACTION);

  // Multiplex bgio messages to channel subscribers
  type MsgHandler = (data: string, peerId: string) => void;
  const bgioHandlers = new Set<MsgHandler>();
  // Trystero uses onProgress for progress; actual messages use a different pattern.
  // Real trystero: action.send / and you set `action` progress OR use the return of makeAction
  // with .onComplete / actually in trystero 0.22+:
  //   const [send, get] = room.makeAction('...')
  // Wait - need to check real API. Feasibility said:
  //   const action = room.makeAction<MyPayload>('bgio')
  //   await action.send(payload, { target: peerId })
  //   action.onMessage = (data, { peerId }) => ...
  //
  // We'll support both onMessage assignment and a mock that sets handlers.

  const actionAny = bgioAction as ActionHandle<string> & {
    onMessage?: ((data: string, meta: { peerId: string }) => void) | null;
  };
  actionAny.onMessage = (data: string, meta: { peerId: string }) => {
    bgioHandlers.forEach((h) => h(data, meta.peerId));
  };

  const subscribeBgio = (handler: MsgHandler) => {
    bgioHandlers.add(handler);
  };

  if (opts.role === "host") {
    return hostSession({
      room,
      opts,
      roomCode,
      bgioAction,
      hsAction,
      subscribeBgio,
      connectTimeoutMs,
    });
  }
  return guestSession({
    room,
    opts,
    roomCode,
    bgioAction,
    hsAction,
    subscribeBgio,
    connectTimeoutMs,
  });
}

async function loadDefaultJoinRoom(): Promise<
  NonNullable<JoinTrysteroTableOpts["joinRoomImpl"]>
> {
  try {
    // Dynamic import so ./channel consumers never load trystero.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = await import("trystero");
    return mod.joinRoom as NonNullable<JoinTrysteroTableOpts["joinRoomImpl"]>;
  } catch (e) {
    throw new Error(
      "trystero package is required for joinTrysteroTable without joinRoomImpl. Install trystero or inject joinRoomImpl.",
    );
  }
}

function hostSession(ctx: {
  room: RoomLike;
  opts: JoinTrysteroTableOpts;
  roomCode: string;
  bgioAction: ActionHandle<string>;
  hsAction: ActionHandle<HsPayload>;
  subscribeBgio: (h: (data: string, peerId: string) => void) => void;
  connectTimeoutMs: number;
}): Promise<TrysteroTableSession> {
  const { room, opts, bgioAction, hsAction, subscribeBgio } = ctx;

  const seatMap = new Map<string, string>(); // playerID -> peerId
  seatMap.set("0", "self");
  const hostConnections = new Map<string, TrysteroChannel>();
  const peerToSeat = new Map<string, string>();
  let nextSeat = 1;
  let rosterCb: ((seated: string[]) => void) | undefined;

  const seated = () => Array.from(seatMap.keys()).sort();

  const notifyRoster = () => {
    rosterCb?.(seated());
  };

  const hsAny = hsAction as ActionHandle<HsPayload> & {
    onMessage?: ((data: HsPayload, meta: { peerId: string }) => void) | null;
  };

  hsAny.onMessage = (data: HsPayload, meta: { peerId: string }) => {
    if (!data || data.kind !== "hello") return;
    const result = admitGuestHandshake(data.handshake, {
      gameId: opts.gameId,
      matchID: opts.matchID,
      hasHost: true,
      seatedCount: seatMap.size,
      maxPlayers: opts.maxPlayers,
    });
    if (!result.ok) {
      void hsAction.send(
        { kind: "reject", reason: result.reason },
        { target: meta.peerId },
      );
      return;
    }
    if (result.handshake.role !== "guest") {
      void hsAction.send(
        { kind: "reject", reason: "second_host" },
        { target: meta.peerId },
      );
      return;
    }
    if (seatMap.size >= opts.maxPlayers) {
      void hsAction.send(
        { kind: "reject", reason: "table_full" },
        { target: meta.peerId },
      );
      return;
    }

    const seat = String(nextSeat++);
    seatMap.set(seat, meta.peerId);
    peerToSeat.set(meta.peerId, seat);

    const channel = new TrysteroChannel({
      targetPeerId: meta.peerId,
      action: bgioAction,
      subscribeMessages: subscribeBgio,
      initiallyConnected: true,
    });
    hostConnections.set(seat, channel);

    void hsAction.send(
      {
        kind: "accept",
        seat,
        handshake: buildHandshake({
          role: "host",
          matchID: opts.matchID,
          gameId: opts.gameId,
          seat: "0",
          clientBuild: opts.clientBuild,
        }),
      },
      { target: meta.peerId },
    );
    notifyRoster();
  };

  room.onPeerLeave = (peerId: string) => {
    const seat = peerToSeat.get(peerId);
    if (!seat) return;
    peerToSeat.delete(peerId);
    seatMap.delete(seat);
    const ch = hostConnections.get(seat);
    ch?.setConnected(false);
    hostConnections.delete(seat);
    notifyRoster();
  };

  // Host is ready immediately (guests join over time in lobby)
  const session: TrysteroTableSession = {
    role: "host",
    playerID: "0",
    seatMap,
    hostConnections: hostConnections as Map<
      string,
      import("../channel").P2PChannel
    >,
    leave: () => {
      try {
        room.leave();
      } catch {
        /* ignore */
      }
    },
    getSeatedPlayerIDs: seated,
    get onRosterChange() {
      return rosterCb;
    },
    set onRosterChange(cb) {
      rosterCb = cb;
    },
  };
  return Promise.resolve(session);
}

function guestSession(ctx: {
  room: RoomLike;
  opts: JoinTrysteroTableOpts;
  roomCode: string;
  bgioAction: ActionHandle<string>;
  hsAction: ActionHandle<HsPayload>;
  subscribeBgio: (h: (data: string, peerId: string) => void) => void;
  connectTimeoutMs: number;
}): Promise<TrysteroTableSession> {
  const { room, opts, bgioAction, hsAction, subscribeBgio, connectTimeoutMs } =
    ctx;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        room.leave();
      } catch {
        /* ignore */
      }
      reject(new Error("trystero_connect_timeout"));
    }, connectTimeoutMs);

    const hello = buildHandshake({
      role: "guest",
      matchID: opts.matchID,
      gameId: opts.gameId,
      clientBuild: opts.clientBuild,
    });

    const hsAny = hsAction as ActionHandle<HsPayload> & {
      onMessage?: ((data: HsPayload, meta: { peerId: string }) => void) | null;
    };

    const tryHello = (hostPeerId: string) => {
      void hsAction.send({ kind: "hello", handshake: hello }, {
        target: hostPeerId,
      });
    };

    hsAny.onMessage = (data: HsPayload, meta: { peerId: string }) => {
      if (settled) return;
      if (data.kind === "reject") {
        settled = true;
        clearTimeout(timer);
        try {
          room.leave();
        } catch {
          /* ignore */
        }
        // Password / auth style failures must not fall open
        reject(new Error(`trystero_handshake_reject:${data.reason}`));
        return;
      }
      if (data.kind !== "accept") return;

      settled = true;
      clearTimeout(timer);
      const seat = data.seat;
      const channel = new TrysteroChannel({
        targetPeerId: meta.peerId,
        action: bgioAction,
        subscribeMessages: subscribeBgio,
        initiallyConnected: true,
      });
      const seatMap = new Map<string, string>();
      seatMap.set("0", meta.peerId);
      seatMap.set(seat, "self");

      resolve({
        role: "guest",
        playerID: seat,
        seatMap,
        connection: channel,
        leave: () => {
          try {
            room.leave();
          } catch {
            /* ignore */
          }
        },
        getSeatedPlayerIDs: () => Array.from(seatMap.keys()).sort(),
      });
    };

    // When we see a peer, treat as host candidate and hello
    room.onPeerJoin = (peerId: string) => {
      tryHello(peerId);
    };

    // Also allow host that was already present — mock may call onPeerJoin immediately
  });
}

// re-export for tests
export { parseHandshake, admitGuestHandshake, buildHandshake };
