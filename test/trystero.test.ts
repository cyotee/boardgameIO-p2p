/**
 * Trystero adapter unit tests — mocked joinRoom (no live Nostr).
 */
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseHandshake,
  admitGuestHandshake,
  buildHandshake,
  TrysteroChannel,
  joinTrysteroTable,
  MANAMESH_HANDSHAKE_V,
} from "../src/trystero";

type Handler = (data: any, meta: { peerId: string }) => void;

function createMockJoinRoom() {
  /** peerId -> room side that receives messages */
  const peers = new Map<
    string,
    {
      bgio: Handler | null;
      hs: Handler | null;
      onPeerJoin: ((id: string) => void) | null;
      onPeerLeave: ((id: string) => void) | null;
    }
  >();

  let peerSeq = 0;

  const joinRoom = (
    _config: unknown,
    _roomId: string,
    _opts?: { onJoinError?: (d: unknown) => void },
  ) => {
    const peerId = `peer${++peerSeq}`;
    const state = {
      bgio: null as Handler | null,
      hs: null as Handler | null,
      onPeerJoin: null as ((id: string) => void) | null,
      onPeerLeave: null as ((id: string) => void) | null,
    };
    peers.set(peerId, state);

    // Notify existing peers that someone joined
    for (const [otherId, other] of peers) {
      if (otherId === peerId) continue;
      // other sees new peer
      queueMicrotask(() => other.onPeerJoin?.(peerId));
      // new peer sees other
      queueMicrotask(() => state.onPeerJoin?.(otherId));
    }

    const makeAction = (name: string) => {
      const action: any = {
        send: (data: any, opts?: { target?: string }) => {
          const target = opts?.target;
          const deliver = (toPeer: string) => {
            const dest = peers.get(toPeer);
            if (!dest) return;
            const handler = name.includes("hs") || name === "manamesh-hs" ? dest.hs : dest.bgio;
            // Use action name
            const h =
              name === "manamesh-hs"
                ? dest.hs
                : name === "manamesh-bgio"
                  ? dest.bgio
                  : null;
            queueMicrotask(() => h?.(data, { peerId }));
          };
          if (target) {
            deliver(target);
          } else {
            for (const id of peers.keys()) {
              if (id !== peerId) deliver(id);
            }
          }
        },
        onProgress: null,
        set onMessage(fn: Handler | null) {
          if (name === "manamesh-hs") state.hs = fn;
          else state.bgio = fn;
        },
        get onMessage(): Handler | null {
          return name === "manamesh-hs" ? state.hs : state.bgio;
        },
      };
      return action;
    };

    const room: any = {
      makeAction,
      leave: () => {
        peers.delete(peerId);
        for (const [, other] of peers) {
          other.onPeerLeave?.(peerId);
        }
      },
      get onPeerJoin() {
        return state.onPeerJoin;
      },
      set onPeerJoin(fn: ((id: string) => void) | null) {
        state.onPeerJoin = fn;
      },
      get onPeerLeave() {
        return state.onPeerLeave;
      },
      set onPeerLeave(fn: ((id: string) => void) | null) {
        state.onPeerLeave = fn;
      },
      _peerId: peerId,
    };
    return room;
  };

  return { joinRoom, peers };
}

describe("room-code", () => {
  test("generateRoomCode length 6–8 and valid", () => {
    for (const len of [6, 7, 8]) {
      const code = generateRoomCode(len);
      expect(code.length).toBe(len);
      expect(isValidRoomCode(code)).toBe(true);
    }
  });

  test("isValidRoomCode rejects bad lengths and chars", () => {
    expect(isValidRoomCode("ABC")).toBe(false);
    expect(isValidRoomCode("ABCDEFGHI")).toBe(false);
    expect(isValidRoomCode("ABC0O1I")).toBe(false); // 0 O 1 I excluded
    expect(isValidRoomCode("ABCDEF")).toBe(true);
  });

  test("normalizeRoomCode uppercases", () => {
    expect(normalizeRoomCode(" abcdef ")).toBe("ABCDEF");
  });
});

describe("handshake", () => {
  test("parseHandshake accepts v1", () => {
    const r = parseHandshake({
      v: MANAMESH_HANDSHAKE_V,
      role: "guest",
      matchID: "m1",
      gameId: "timestreams",
    });
    expect(r.ok).toBe(true);
  });

  test("parseHandshake rejects bad version", () => {
    const r = parseHandshake({
      v: 99,
      role: "guest",
      matchID: "m1",
      gameId: "timestreams",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_version");
  });

  test("admitGuestHandshake rejects second host, full table, wrong game", () => {
    const base = buildHandshake({
      role: "guest",
      matchID: "m1",
      gameId: "timestreams",
    });
    expect(
      admitGuestHandshake(base, {
        gameId: "poker",
        matchID: "m1",
        hasHost: true,
        seatedCount: 1,
        maxPlayers: 4,
      }).ok,
    ).toBe(false);

    const hostHs = buildHandshake({
      role: "host",
      matchID: "m1",
      gameId: "timestreams",
    });
    const second = admitGuestHandshake(hostHs, {
      gameId: "timestreams",
      matchID: "m1",
      hasHost: true,
      seatedCount: 1,
      maxPlayers: 4,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("second_host");

    const full = admitGuestHandshake(base, {
      gameId: "timestreams",
      matchID: "m1",
      hasHost: true,
      seatedCount: 4,
      maxPlayers: 4,
    });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toBe("table_full");
  });
});

describe("TrysteroChannel", () => {
  test("send targets peer and inbound onMessage", () => {
    const sent: { data: string; target?: string }[] = [];
    let handler: ((data: string, peerId: string) => void) | null = null;
    const action = {
      send: (data: string, opts?: { target?: string }) => {
        sent.push({ data, target: opts?.target });
      },
    };
    const ch = new TrysteroChannel({
      targetPeerId: "peerB",
      action,
      subscribeMessages: (h) => {
        handler = h;
      },
    });
    const received: string[] = [];
    ch.events.onMessage = (d) => received.push(d);

    ch.send("hello");
    expect(sent).toEqual([{ data: "hello", target: "peerB" }]);

    handler!("from-b", "peerB");
    handler!("from-other", "peerX");
    expect(received).toEqual(["from-b"]);

    ch.setConnected(false);
    expect(ch.isConnected()).toBe(false);
  });
});

describe("joinTrysteroTable (mocked)", () => {
  test("host + guest FIFO seat assignment and channels", async () => {
    const { joinRoom } = createMockJoinRoom();

    const hostP = joinTrysteroTable({
      appId: "test",
      roomCode: "ABCDEF",
      role: "host",
      gameId: "timestreams",
      matchID: "ts_ABCDEF",
      maxPlayers: 4,
      joinRoomImpl: joinRoom as any,
    });

    const host = await hostP;
    expect(host.playerID).toBe("0");
    expect(host.hostConnections).toBeDefined();

    const guest = await joinTrysteroTable({
      appId: "test",
      roomCode: "ABCDEF",
      role: "guest",
      gameId: "timestreams",
      matchID: "ts_ABCDEF",
      maxPlayers: 4,
      joinRoomImpl: joinRoom as any,
      connectTimeoutMs: 2000,
    });

    expect(guest.role).toBe("guest");
    expect(guest.playerID).toBe("1");
    expect(guest.connection).toBeDefined();
    expect(guest.connection!.isConnected()).toBe(true);

    // Host should have seat 1 channel after handshake microtasks
    await new Promise((r) => setTimeout(r, 50));
    expect(host.hostConnections!.has("1")).toBe(true);

    // Second guest gets seat 2
    const guest2 = await joinTrysteroTable({
      appId: "test",
      roomCode: "ABCDEF",
      role: "guest",
      gameId: "timestreams",
      matchID: "ts_ABCDEF",
      maxPlayers: 4,
      joinRoomImpl: joinRoom as any,
      connectTimeoutMs: 2000,
    });
    expect(guest2.playerID).toBe("2");
    await new Promise((r) => setTimeout(r, 50));
    expect(host.hostConnections!.has("2")).toBe(true);

    // bgio round-trip host -> guest
    const got: string[] = [];
    guest.connection!.events.onMessage = (d) => got.push(d);
    host.hostConnections!.get("1")!.send(JSON.stringify({ type: "ping" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(got.some((g) => g.includes("ping"))).toBe(true);

    host.leave();
    guest.leave();
    guest2.leave();
  });

  test("rejects wrong gameId via handshake", async () => {
    const { joinRoom } = createMockJoinRoom();
    const host = await joinTrysteroTable({
      appId: "test",
      roomCode: "XYZABC",
      role: "host",
      gameId: "timestreams",
      matchID: "m1",
      maxPlayers: 2,
      joinRoomImpl: joinRoom as any,
    });

    await expect(
      joinTrysteroTable({
        appId: "test",
        roomCode: "XYZABC",
        role: "guest",
        gameId: "poker",
        matchID: "m1",
        maxPlayers: 2,
        joinRoomImpl: joinRoom as any,
        connectTimeoutMs: 500,
      }),
    ).rejects.toThrow(/handshake_reject|game_id|timeout|trystero/);

    host.leave();
  });

  test("invalid room code throws", async () => {
    await expect(
      joinTrysteroTable({
        appId: "test",
        roomCode: "no",
        role: "host",
        gameId: "timestreams",
        matchID: "m",
        maxPlayers: 2,
        joinRoomImpl: (() => ({})) as any,
      }),
    ).rejects.toThrow("invalid_room_code");
  });
});
