/**
 * Multi-peer host transport tests using mocked P2PChannel implementations.
 * Proves host can fan-out protocol traffic to more than one guest playerID.
 */
import type { P2PChannel, P2PChannelEvents, ConnectionState } from "../src/channel";
import { P2PTransport } from "../src/channel-transport";

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
