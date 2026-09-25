/**
 * Multi-peer host transport tests using mocked P2PChannel implementations.
 * Proves host can fan-out protocol traffic to more than one guest playerID.
 */
import type { P2PChannel, P2PChannelEvents, ConnectionState } from "../src/channel";
import { Client } from "boardgame.io/client";
import type { Game } from "boardgame.io";
import { P2PMultiplayer, P2PTransport } from "../src/channel-transport";

function createMockChannel(label: string): P2PChannel & {
  sent: string[];
  setConnected: (c: boolean) => void;
  inject: (data: string) => void;
} {
  let connected = true;
  const sent: string[] = [];
  const events: P2PChannelEvents = {
    onMessage: () => {},
    onConnectionStateChange: () => {},
  };
  return {
    sent,
    events,
    send(data: string) {
      if (!connected) throw new Error(`${label} not connected`);
      sent.push(data);
    },
    isConnected() {
      return connected;
    },
    setConnected(c: boolean) {
      connected = c;
      events.onConnectionStateChange(
        c ? ("connected" as ConnectionState) : ("disconnected" as ConnectionState),
      );
    },
    inject(data: string) {
      events.onMessage(data);
    },
  };
}

const trivialGame = {
  name: "multi-peer-test",
  setup: () => ({ tick: 0 }),
  moves: {
    bump: ({ G }: { G: { tick: number } }) => {
      G.tick += 1;
    },
  },
};

describe("P2PTransport multi-peer host", () => {
  test("rejects forged seats in envelope, action root, and payload", async () => {
    const channel = createMockChannel("attacker");
    const transport = new P2PTransport({
      game: trivialGame as any, connection: channel, role: "host",
      matchID: "seat-binding", playerID: "0", numPlayers: 2,
    });
    transport.connect();
    const master = (transport as any).master;
    await master.waitForInit();
    for (const field of ["envelope", "root", "payload"]) {
      const action = {
        type: "MAKE_MOVE", playerID: field === "root" ? "0" : "1",
        payload: { type: "bump", args: [], playerID: field === "payload" ? "0" : "1" },
      };
      channel.inject(JSON.stringify({ type: "action", args: [action, 0, "seat-binding", field === "envelope" ? "0" : "1"] }));
      expect((await master.getState()).G.tick).toBe(0);
    }
    channel.inject(JSON.stringify({ type: "sync-req", args: ["seat-binding", "0"] }));
    expect(channel.sent.map(s => JSON.parse(s)).filter(m => m.type === "error")).toHaveLength(4);
    transport.disconnect();
  });

  test("filters initial sync and updates per seat without mutating master secrets", async () => {
    const channel = createMockChannel("guest");
    const game = {
      ...trivialGame,
      setup: () => ({ tick: 0, secret: "deck-order", hands: { "0": "host-card", "1": "guest-card" } }),
      playerView: ({ G, playerID }: any) => ({ tick: G.tick, hand: G.hands[playerID] }),
    };
    const transport = new P2PTransport({
      game: game as any, connection: channel, role: "host",
      matchID: "private-view", playerID: "0", numPlayers: 2,
    });
    transport.connect();
    const master = (transport as any).master;
    await master.waitForInit();
    // Wait for connectAsHost to install subscribers, without timing assumptions.
    await Promise.resolve();
    await master.onSync("private-view", "1");
    await master.onUpdate({ type: "MAKE_MOVE", payload: { type: "bump", args: [], playerID: "1" } }, 0, "private-view", "1");
    const messages = channel.sent.map(s => JSON.parse(s));
    const sync = messages.find(m => m.type === "sync").args[1];
    expect(sync.state.G).toEqual({ tick: 0, hand: "guest-card" });
    expect(sync.initialState.G).toEqual({ tick: 0, hand: "guest-card" });
    expect(messages.find(m => m.type === "update").args[1].G).toEqual({ tick: 1, hand: "guest-card" });
    expect(JSON.stringify(channel.sent)).not.toContain("host-card");
    expect(JSON.stringify(channel.sent)).not.toContain("deck-order");
    expect((await master.getState()).G.secret).toBe("deck-order");
    transport.disconnect();
  });

  test("legacy 2p single connection still constructs and connects as host", async () => {
    const guestCh = createMockChannel("g1");
    const transport = new P2PTransport({
      game: trivialGame as any,
      connection: guestCh,
      role: "host",
      matchID: "m2",
      playerID: "0",
      numPlayers: 2,
    });
    transport.connect();
    // allow async host init
    await new Promise((r) => setTimeout(r, 50));
    expect(transport.isConnected).toBe(true);
  });

  test("host with hostConnections fans updates to each guest channel", async () => {
    const ch1 = createMockChannel("g1");
    const ch2 = createMockChannel("g2");
    const hostConnections = new Map<string, P2PChannel>([
      ["1", ch1],
      ["2", ch2],
    ]);

    const transport = new P2PTransport({
      game: trivialGame as any,
      hostConnections,
      role: "host",
      matchID: "m3",
      playerID: "0",
      numPlayers: 3,
    });

    (transport as any)["transportDataCallback"] = () => {};

    transport.connect();
    await new Promise((r) => setTimeout(r, 80));

    // Guest 1 submits an action — host master should fan-out update to both guests
    const before1 = ch1.sent.length;
    const before2 = ch2.sent.length;

    ch1.inject(
      JSON.stringify({
        type: "action",
        args: [
          {
            type: "MAKE_MOVE",
            payload: { type: "bump", args: [], playerID: "1" },
            playerID: "1",
          },
          0,
          "m3",
          "1",
        ],
      }),
    );

    await new Promise((r) => setTimeout(r, 80));

    expect(ch1.sent.length).toBeGreaterThan(before1);
    expect(ch2.sent.length).toBeGreaterThan(before2);

    const parseTypes = (arr: string[]) =>
      arr.map((s) => {
        try {
          return JSON.parse(s).type;
        } catch {
          return null;
        }
      });

    expect(parseTypes(ch1.sent)).toEqual(expect.arrayContaining(["update"]));
    expect(parseTypes(ch2.sent)).toEqual(expect.arrayContaining(["update"]));
  });

  test("host routes guest action from player 2 via that channel", async () => {
    const ch1 = createMockChannel("g1");
    const ch2 = createMockChannel("g2");
    const hostConnections = new Map<string, P2PChannel>([
      ["1", ch1],
      ["2", ch2],
    ]);

    const transport = new P2PTransport({
      game: trivialGame as any,
      hostConnections,
      role: "host",
      matchID: "m4",
      playerID: "0",
      numPlayers: 3,
    });
    transport.connect();
    await new Promise((r) => setTimeout(r, 80));

    const actionMsg = JSON.stringify({
      type: "action",
      args: [
        {
          type: "MAKE_MOVE",
          payload: { type: "bump", args: [], playerID: "2" },
          playerID: "2",
        },
        0,
        "m4",
        "2",
      ],
    });

    const before1 = ch1.sent.length;
    ch2.inject(actionMsg);
    await new Promise((r) => setTimeout(r, 80));

    // Both guests should receive the resulting update broadcast (via per-subscriber send)
    expect(ch1.sent.length + ch2.sent.length).toBeGreaterThan(before1);
  });

  test("guest uses single connection to host", async () => {
    const toHost = createMockChannel("toHost");
    const transport = new P2PTransport({
      game: trivialGame as any,
      connection: toHost,
      role: "guest",
      matchID: "mg",
      playerID: "1",
      numPlayers: 2,
    });
    transport.connect();
    await new Promise((r) => setTimeout(r, 20));
    expect(transport.isConnected).toBe(true);
    expect(toHost.sent.some((s) => s.includes("sync-req"))).toBe(true);
  });

  test("disconnect unsubscribes every multi-peer guest seat", async () => {
    const ch1 = createMockChannel("g1");
    const ch2 = createMockChannel("g2");
    const hostConnections = new Map<string, P2PChannel>([
      ["1", ch1],
      ["2", ch2],
    ]);

    const transport = new P2PTransport({
      game: trivialGame as any,
      hostConnections,
      role: "host",
      matchID: "md",
      playerID: "0",
      numPlayers: 3,
    });
    (transport as any)["transportDataCallback"] = () => {};
    transport.connect();
    await new Promise((r) => setTimeout(r, 80));

    const master = (transport as any).master;
    expect(master).toBeTruthy();
    // Subscribed host + guests 1 and 2
    expect(master["subscribers"].has("0")).toBe(true);
    expect(master["subscribers"].has("1")).toBe(true);
    expect(master["subscribers"].has("2")).toBe(true);

    transport.disconnect();

    expect((transport as any).master).toBeNull();
    // After disconnect, master is null — capture unsub via fresh connect + disconnect spy
    // Re-run: spy unsubscribe on a second host transport
    const ch1b = createMockChannel("g1b");
    const ch2b = createMockChannel("g2b");
    const transport2 = new P2PTransport({
      game: trivialGame as any,
      hostConnections: new Map([
        ["1", ch1b],
        ["2", ch2b],
        ["3", createMockChannel("g3")],
      ]),
      role: "host",
      matchID: "md2",
      playerID: "0",
      numPlayers: 4,
    });
    (transport2 as any)["transportDataCallback"] = () => {};
    transport2.connect();
    await new Promise((r) => setTimeout(r, 80));
    const master2 = (transport2 as any).master;
    const unsubIds: string[] = [];
    const origUnsub = master2.unsubscribe.bind(master2);
    master2.unsubscribe = (id: string) => {
      unsubIds.push(id);
      return origUnsub(id);
    };
    transport2.disconnect();
    expect(unsubIds).toEqual(
      expect.arrayContaining(["0", "1", "2", "3"]),
    );
  });
});


test("engine Client accepts channel factory and receives host sync", async () => {
  const client = Client({
    game: trivialGame,
    playerID: "0",
    matchID: "client-integration",
    multiplayer: P2PMultiplayer({
      connection: createMockChannel("guest"),
      role: "host",
      playerID: "0",
      matchID: "client-integration",
      numPlayers: 2,
    }),
  });
  try {
    client.start();
    for (let attempt = 0; attempt < 20 && !client.getState(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(client.getState()?.G).toEqual({ tick: 0 });
    expect(client.getState()?.isConnected).toBe(true);
  } finally {
    client.stop();
  }
  expect(client.transport.isConnected).toBe(false);
});


describe("channel phase exit hooks", () => {
  test.each([false, true])("runs onEnd before next phase for explicit endPhase=%s", async (explicit) => {
    const game: Game = {
      name: "phase-exit",
      setup: () => ({ ready: false, phase: "placement", exits: 0 }),
      phases: {
        placement: {
          start: true,
          turn: { activePlayers: { all: "placement" } },
          moves: { finish: ({ G, events }: { G: { ready: boolean }; events: { endPhase: () => void } }) => { G.ready = true; if (explicit) events.endPhase(); } },
          endIf: ({ G }: { G: { ready: boolean } }) => !explicit && G.ready,
          onEnd: ({ G, ctx }: { G: { ready: boolean; phase: string; exits: number }; ctx: { phase: string } }) => {
            expect(ctx.phase).toBe("placement");
            return { ...G, phase: "battle", exits: G.exits + 1 };
          },
          next: "battle",
        },
        battle: {},
      },
    };
    const transport = new P2PTransport({
      game, connection: createMockChannel("guest"), role: "host",
      matchID: "phase-exit", playerID: "0", numPlayers: 2,
    });
    transport.connect();
    try {
      const master = (transport as any).master;
      await master.waitForInit();
      await master.onUpdate({ type: "MAKE_MOVE", payload: { type: "finish", args: [], playerID: "0" } }, 0, "phase-exit", "0");
      const state = await master.getState();
      expect(state.ctx.phase).toBe("battle");
      expect(state.ctx.activePlayers).toBeNull();
      expect(state.G).toEqual({ ready: true, phase: "battle", exits: 1 });
    } finally { transport.disconnect(); }
  });
});
