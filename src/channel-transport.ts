/**
 * Channel-based boardgame.io P2P transport (ManaMesh / join-code path).
 *
 * Uses an injected {@link P2PChannel} (e.g. WebRTC join-code connection) instead
 * of PeerJS. PeerJS remains available via {@link P2P} from the package root.
 *
 * Architecture:
 * - Host embeds a game master to maintain authoritative game state
 * - Guest sends actions to host via the channel
 * - Host processes actions and broadcasts state updates to guest
 */

import type {
  Game,
  State,
  ChatMessage,
  FilteredMetadata,
  LogEntry,
  Ctx,
} from "boardgame.io";
import { Transport } from "boardgame.io/internal";
import { INVALID_MOVE } from "boardgame.io/core";
import type { ConnectionState, P2PChannel } from "./channel";
import {
  isAssetSharingMessage,
  type AssetSharingMessage,
} from "./extension-messages";

const MATCH_STATE_PREFIX = "timestreams_match_state_v1:";

/**
 * Host-side game storage: in-memory + localStorage so a host refresh can
 * resume the same matchID without resetting the board.
 */
export class BrowserStorage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private state: State<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private initialState: State<any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private metadata: any = null;
  private log: LogEntry[] = [];
  private matchID: string | null = null;
  /** When true, createMatch may restore from localStorage (host resume). */
  preferRestore = false;

  private persistKey(matchID: string): string {
    return MATCH_STATE_PREFIX + matchID;
  }

  private writePersist(): void {
    if (!this.matchID || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(
        this.persistKey(this.matchID),
        JSON.stringify({
          state: this.state,
          initialState: this.initialState,
          metadata: this.metadata,
          log: this.log,
          savedAt: Date.now(),
        }),
      );
    } catch (e) {
      console.warn("[BrowserStorage] persist failed", e);
    }
  }

  /** Load a previously saved match (host resume). Returns true if found. */
  loadPersisted(matchID: string): boolean {
    if (typeof localStorage === "undefined") return false;
    try {
      const raw = localStorage.getItem(this.persistKey(matchID));
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data?.state) return false;
      this.matchID = matchID;
      this.state = data.state;
      this.initialState = data.initialState ?? data.state;
      this.metadata = data.metadata ?? null;
      this.log = Array.isArray(data.log) ? data.log : [];
      console.log("[BrowserStorage] Restored match", matchID, "from localStorage");
      return true;
    } catch (e) {
      console.warn("[BrowserStorage] loadPersisted failed", e);
      return false;
    }
  }

  static clearPersisted(matchID: string): void {
    try {
      localStorage.removeItem(MATCH_STATE_PREFIX + matchID);
    } catch {
      /* ignore */
    }
  }

  async createMatch(
    matchID: string,
    opts: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialState: State<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: any;
    },
  ): Promise<void> {
    this.matchID = matchID;
    // Prefer restored state when host is resuming this matchID
    if (this.preferRestore && this.loadPersisted(matchID)) {
      if (opts.metadata) this.metadata = { ...this.metadata, ...opts.metadata };
      return;
    }
    this.state = opts.initialState;
    this.initialState = opts.initialState;
    this.metadata = opts.metadata;
    this.log = [];
    this.writePersist();
  }

  async fetch(
    matchID: string,
    opts: {
      state?: boolean;
      metadata?: boolean;
      log?: boolean;
      initialState?: boolean;
    },
  ): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state?: State<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialState?: State<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata?: any;
    log?: LogEntry[];
  }> {
    const result: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state?: State<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      initialState?: State<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: any;
      log?: LogEntry[];
    } = {};

    if (opts.state) result.state = this.state || undefined;
    if (opts.initialState) result.initialState = this.initialState || undefined;
    if (opts.metadata) result.metadata = this.metadata;
    if (opts.log) result.log = this.log;

    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setState(
    matchID: string,
    state: State<any>,
    deltalog?: LogEntry[],
  ): Promise<void> {
    this.matchID = matchID;
    this.state = state;
    if (deltalog) {
      this.log = [...this.log, ...deltalog];
    }
    this.writePersist();
  }
}

/** Session ticket for rejoin after refresh (both host and guest). */
export const TIMESTREAMS_SESSION_KEY = "timestreams_p2p_session_v1";

export interface TimestreamsP2PSession {
  matchID: string;
  playerID: string;
  role: P2PRole;
  homeEraAssignment?: string;
  rulesEnabled?: boolean;
  playMode?: string;
  /** First offer fragment so both peers can re-derive the same matchID after a new handshake. */
  stableSessionId: string;
  savedAt: number;
}

export function saveTimestreamsSession(session: TimestreamsP2PSession): void {
  try {
    localStorage.setItem(TIMESTREAMS_SESSION_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function loadTimestreamsSession(): TimestreamsP2PSession | null {
  try {
    const raw = localStorage.getItem(TIMESTREAMS_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as TimestreamsP2PSession;
    if (!s?.matchID || !s?.playerID || !s?.role) return null;
    // Expire after 24h
    if (s.savedAt && Date.now() - s.savedAt > 24 * 60 * 60 * 1000) {
      clearTimestreamsSession();
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearTimestreamsSession(): void {
  try {
    localStorage.removeItem(TIMESTREAMS_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// Message types sent over the P2P data channel
export type P2PMessageType =
  | "action" // Guest -> Host: player action
  | "sync-req" // Guest -> Host: request state sync
  | "chat" // Both: chat message
  | "update" // Host -> Guest: state update
  | "sync" // Host -> Guest: full state sync response
  | "matchData" // Host -> Guest: player metadata
  | "patch" // Host -> Guest: incremental state patch
  | "error" // Both: error message
  // Asset sharing protocol (both directions)
  | "deck-list-share"
  | "deck-list-ack"
  | "asset-pack-request"
  | "asset-pack-offer"
  | "asset-pack-chunk"
  | "asset-pack-complete"
  | "asset-pack-denied"
  | "asset-pack-cancel";

export interface P2PMessage {
  type: P2PMessageType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[];
}

export type P2PRole = "host" | "guest";

export interface P2PTransportOpts {
  game: Game;
  /**
   * Pre-established peer data channel.
   * - Guest: required (channel to host).
   * - Host 2p legacy: single channel to the one guest.
   * - Host multi-peer: omit and pass {@link hostConnections} instead
   *   (or pass both — hostConnections takes precedence for fan-out).
   */
  connection?: P2PChannel;
  /**
   * Host only: one channel per guest boardgame.io playerID (`"1"`, `"2"`, …).
   * When set, state updates are broadcast to every guest channel and
   * inbound messages are demuxed per channel.
   */
  hostConnections?: Map<string, P2PChannel>;
  role: P2PRole;
  matchID?: string;
  playerID?: string;
  numPlayers?: number;
  credentials?: string;
  /** Host: load board state from localStorage for this matchID after WebRTC re-handshake. */
  restoreFromPersist?: boolean;
  /** Passed to game.setup as the second argument (moduleConfig, decks, etc.) */
  setupData?: unknown;
}

type TransportOpts = ConstructorParameters<typeof Transport>[0];
type TransportDataCallback = TransportOpts["transportDataCallback"];
type TransportData = Parameters<TransportDataCallback>[0];

interface ConnectionStatusCallback {
  (): void;
}

/**
 * Find the starting phase from game config
 * Looks for a phase with start: true
 */
function findStartingPhase(game: Game): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  if (!phases) return null;

  for (const [phaseName, phaseConfig] of Object.entries(phases)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((phaseConfig as any).start === true) {
      return phaseName;
    }
  }
  return null;
}

/**
 * Create an initial game state
 * This is a simplified version of boardgame.io's InitializeGame
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initializeGameState(
  game: Game,
  numPlayers: number,
  setupData?: unknown,
): State<any> {
  // Find the starting phase from game config
  const startingPhase = findStartingPhase(game);

  const playOrder = Array.from({ length: numPlayers }, (_, i) => String(i));
  let ctx: Ctx = {
    numPlayers,
    playOrder,
    playOrderPos: 0,
    activePlayers: null,
    currentPlayer: "0",
    numMoves: 0,
    turn: 1,
    phase: startingPhase || null,
  };

  // boardgame.io setup receives a FnContext-like first arg in modern APIs,
  // but this monorepo's TimestreamsGame.setup expects (ctx, setupData).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const G = game.setup
    ? (game.setup as any)({ ...ctx, playOrder }, setupData)
    : {};

  // Run onBegin + activePlayers for the starting phase if present
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  if (startingPhase && phases?.[startingPhase]) {
    if (phases[startingPhase].onBegin) {
      phases[startingPhase].onBegin({ G, ctx });
    }
    const active = resolveActivePlayers(game, ctx, G);
    if (active) {
      ctx = { ...ctx, activePlayers: active as Ctx["activePlayers"] };
    }
  }

  return {
    G,
    ctx,
    plugins: {},
    _stateID: 0,
    _undo: [],
    _redo: [],
  };
}

/**
 * Expand phase turn.activePlayers (e.g. `{ all: null }`) into a per-seat map
 * boardgame.io clients understand (`{ "0": null, "1": null }`).
 * Without this, P2P left activePlayers null forever and only currentPlayer
 * looked "active" — concurrent decrypt / off-turn prompts break, and guests
 * can miss that the turn advanced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveActivePlayers(
  game: Game,
  ctx: Ctx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  G: any,
): Record<string, null> | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  const phaseTurn = ctx.phase ? phases?.[ctx.phase]?.turn : undefined;
  const ap = phaseTurn?.activePlayers ?? (game as any).turn?.activePlayers;
  if (!ap) return null;

  const playOrder: string[] =
    (ctx.playOrder as string[]) ||
    (G?.playerOrder as string[]) ||
    Array.from({ length: ctx.numPlayers }, (_, i) => String(i));

  // { all: Stage.NULL } / { all: null } → every seat active
  if (Object.prototype.hasOwnProperty.call(ap, "all")) {
    const stage = (ap as { all: null }).all;
    const out: Record<string, null> = {};
    for (const pid of playOrder) {
      out[pid] = stage;
    }
    return out;
  }

  // { value: { "0": null, "1": null } } or plain map of seats
  if (ap.value && typeof ap.value === "object") {
    return { ...ap.value };
  }
  if (typeof ap === "object") {
    return { ...ap };
  }
  return null;
}

/**
 * Invoke phase onBegin when entering a new phase, and apply concurrent seats.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runPhaseOnBegin(game: Game, G: any, ctx: Ctx): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  if (!ctx.phase || !phases?.[ctx.phase]) return;
  const phaseConfig = phases[ctx.phase];
  if (phaseConfig.onBegin) {
    phaseConfig.onBegin({ G, ctx });
  }
  // Mutate ctx so callers that spread it pick up activePlayers.
  const active = resolveActivePlayers(game, ctx, G);
  ctx.activePlayers = (active ?? null) as Ctx["activePlayers"];
}

/**
 * Resolve next player index using phase/game turn.order if available.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveNextPlayOrderPos(game: Game, G: any, ctx: Ctx): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  const phaseTurn = ctx.phase ? phases?.[ctx.phase]?.turn : undefined;
  const order = phaseTurn?.order ?? (game as any).turn?.order;
  if (order?.next) {
    try {
      const next = order.next({ G, ctx });
      if (typeof next === "number" && next >= 0) return next;
    } catch {
      /* fall through */
    }
  }
  return (ctx.playOrderPos + 1) % ctx.numPlayers;
}

/**
 * Find a move definition from the game config.
 * Order: phase moves → phase stage moves → top-level moves.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findMove(
  game: Game,
  moveType: string,
  phase: string | null,
): { move: (args: any, ...moveArgs: any[]) => any; ignoreStaleStateID?: boolean } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phases = (game as any).phases;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let moveDef: any = phase ? phases?.[phase]?.moves?.[moveType] : undefined;

  // Stage moves (e.g. turn.stages.crypto.moves.submitPublicKey)
  if (!moveDef && phase) {
    const stages = phases?.[phase]?.turn?.stages;
    if (stages) {
      for (const stageName of Object.keys(stages)) {
        const stageMove = stages[stageName]?.moves?.[moveType];
        if (stageMove) {
          moveDef = stageMove;
          break;
        }
      }
    }
  }

  if (!moveDef) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    moveDef = (game.moves as any)?.[moveType];
  }

  if (!moveDef) {
    return null;
  }

  if (typeof moveDef === "function") {
    return { move: moveDef };
  }
  if (typeof moveDef === "object" && typeof moveDef.move === "function") {
    return {
      move: moveDef.move,
      ignoreStaleStateID: !!moveDef.ignoreStaleStateID,
    };
  }

  return null;
}

/**
 * Apply an action to the game state
 * This is a simplified game reducer
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAction(
  game: Game,
  state: State<any>,
  action: any,
): State<any> | typeof INVALID_MOVE {
  const { type, payload } = action;
  // boardgame.io puts playerID on payload; P2P may also stitch it on the action root.
  const playerID =
    payload?.playerID ?? action.playerID ?? action.payload?.playerID ?? null;

  if (type !== "MAKE_MOVE") {
    // We only handle MAKE_MOVE actions for now
    return INVALID_MOVE;
  }

  const { type: moveType, args } = payload || {};
  const found = findMove(game, moveType, state.ctx.phase);

  if (!found) {
    console.log(
      "[applyAction] Move not found:",
      moveType,
      "phase:",
      state.ctx.phase,
    );
    return INVALID_MOVE;
  }
  const move = found.move;

  // Create a copy of the state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let G = JSON.parse(JSON.stringify(state.G)) as any;
  let ctx = { ...state.ctx };

  // Track events triggered by the move
  let phaseEnded = false;
  let turnEnded = false;

  // Create events object for moves to use
  const events = {
    endPhase: () => {
      console.log("[applyAction] endPhase called");
      phaseEnded = true;
    },
    endTurn: () => {
      console.log("[applyAction] endTurn called");
      turnEnded = true;
    },
  };

  // Call the move with events
  if (!playerID) {
    console.error("[applyAction] Missing playerID on action", action);
    return INVALID_MOVE;
  }
  const moveArgs = { G, ctx, playerID, events };
  const result = move(moveArgs, ...(Array.isArray(args) ? args : []));

  // Handle move result
  if (result === INVALID_MOVE) {
    return INVALID_MOVE;
  }

  // If the move returns a new G object, use it. Ignore non-object returns
  // (legacy moves that returned booleans would otherwise corrupt G).
  if (result !== undefined && result !== null && typeof result === "object") {
    G = result;
  }

  /** Align ctx.currentPlayer using phase turn.order.first (home-era chronology). */
  const alignPhaseFirstPlayer = (nextPhase: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nextPhaseConfig = (game.phases as any)?.[nextPhase];
    const firstFn = nextPhaseConfig?.turn?.order?.first;
    if (typeof firstFn !== "function") return;
    try {
      const firstPos = firstFn({ G, ctx });
      if (typeof firstPos === "number" && firstPos >= 0) {
        // firstPos is an index into G.playerOrder / ctx.playOrder (same seats).
        const playOrder = ctx.playOrder || G.playerOrder || [];
        const pid = playOrder[firstPos] ?? G.playerOrder?.[firstPos];
        if (pid != null) {
          ctx = {
            ...ctx,
            playOrderPos: firstPos,
            currentPlayer: String(pid),
            numMoves: 0,
          };
          console.log(
            "[applyAction] First player for",
            nextPhase,
            "→",
            ctx.currentPlayer,
            "(pos",
            firstPos,
            ")",
          );
        }
      }
    } catch (err) {
      console.warn("[applyAction] turn.order.first failed", err);
    }
  };

  // Handle phase transition (events.endPhase — e.g. last shuffle → play)
  if (phaseEnded && game.phases) {
    const currentPhase = ctx.phase;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phaseConfig = (game.phases as any)[currentPhase as string];
    if (phaseConfig?.next) {
      G = phaseConfig.onEnd?.({ G, ctx, events }) ?? G;
      const nextPhase =
        typeof phaseConfig.next === "function"
          ? phaseConfig.next({ G, ctx })
          : phaseConfig.next;
      console.log(
        "[applyAction] Transitioning from phase",
        currentPhase,
        "to",
        nextPhase,
      );
      ctx = { ...ctx, phase: nextPhase };
      runPhaseOnBegin(game, G, ctx);
      alignPhaseFirstPlayer(nextPhase);
    }
  }

  // Check phase endIf (automatic phase transition) — may chain once more
  // (e.g. setup → play, or keyExchange → encrypt after last key).
  if (game.phases && ctx.phase) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phaseConfig = (game.phases as any)[ctx.phase];
    if (phaseConfig?.endIf) {
      const shouldEnd = phaseConfig.endIf({ G, ctx });
      if (shouldEnd && phaseConfig.next) {
        G = phaseConfig.onEnd?.({ G, ctx, events }) ?? G;
        const nextPhase =
          typeof phaseConfig.next === "function"
            ? phaseConfig.next({ G, ctx })
            : phaseConfig.next;
        console.log(
          "[applyAction] Phase endIf triggered, transitioning to",
          nextPhase,
        );
        ctx = { ...ctx, phase: nextPhase };
        runPhaseOnBegin(game, G, ctx);
        alignPhaseFirstPlayer(nextPhase);
      }
    }
  }

  // Check for end turn
  const numMoves = (ctx.numMoves || 0) + 1;
  const shouldEndTurn =
    turnEnded || (game.turn?.maxMoves && numMoves >= game.turn.maxMoves);

  let newCtx = { ...ctx, numMoves };

  if (shouldEndTurn) {
    const nextPos = resolveNextPlayOrderPos(game, G, { ...ctx, numMoves });
    const playOrder = ctx.playOrder || G.playerOrder || [];
    const nextPid = playOrder[nextPos] ?? G.playerOrder?.[nextPos] ?? ctx.currentPlayer;
    newCtx = {
      ...newCtx,
      playOrderPos: nextPos,
      currentPlayer: String(nextPid),
      numMoves: 0,
      turn: (ctx.turn || 0) + 1,
    };
    // Re-apply phase concurrent seats after turn change (boardgame.io does this;
    // without it guests keep a stale null activePlayers and never look "active").
    const active = resolveActivePlayers(game, newCtx, G);
    if (active) {
      newCtx = {
        ...newCtx,
        activePlayers: active as Ctx["activePlayers"],
      };
    }
    console.log(
      "[applyAction] endTurn → currentPlayer",
      newCtx.currentPlayer,
      "day",
      G.currentDay,
      "activePlayers",
      newCtx.activePlayers,
      "startOfDayPending was consumed by turn.order.next if set",
    );
  }

  // Check for game end
  let gameover;
  if (game.endIf) {
    gameover = game.endIf({ G, ctx: newCtx });
  }

  return {
    G,
    ctx: gameover ? { ...newCtx, gameover } : newCtx,
    plugins: state.plugins,
    _stateID: state._stateID + 1,
  };
}

/**
 * Simple in-memory game master for host
 */
class P2PMaster {
  private game: Game;
  private db: BrowserStorage;
  private matchID: string;
  private numPlayers: number;
  private setupData?: unknown;
  private subscribers: Map<string, (data: P2PMessage) => void> = new Map();
  private initialized: Promise<void>;
  private _isInitialized = false;

  constructor(
    game: Game,
    matchID: string,
    numPlayers: number,
    setupData?: unknown,
    opts?: { restoreFromPersist?: boolean },
  ) {
    this.game = game;
    this.db = new BrowserStorage();
    this.db.preferRestore = !!opts?.restoreFromPersist;
    this.matchID = matchID;
    this.numPlayers = numPlayers;
    this.setupData = setupData;

    // Initialize the game state and store the promise
    this.initialized = this.initGame();
  }

  private async initGame(): Promise<void> {
    const initialState = initializeGameState(
      this.game,
      this.numPlayers,
      this.setupData,
    );

    await this.db.createMatch(this.matchID, {
      initialState,
      metadata: {
        gameName: this.game.name || "unknown",
        players: this.createInitialPlayers(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    this._isInitialized = true;
    console.log("[P2PMaster] Game initialized with state:", initialState);
  }

  async waitForInit(): Promise<void> {
    await this.initialized;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  private createInitialPlayers(): Record<
    number,
    { id: number; name?: string }
  > {
    const players: Record<number, { id: number; name?: string }> = {};
    for (let i = 0; i < this.numPlayers; i++) {
      players[i] = { id: i };
    }
    return players;
  }

  subscribe(playerID: string, callback: (data: P2PMessage) => void): void {
    this.subscribers.set(playerID, callback);
  }

  unsubscribe(playerID: string): void {
    this.subscribers.delete(playerID);
  }

  private notifyAll(data: P2PMessage): void {
    this.subscribers.forEach((callback) => {
      callback(data);
    });
  }

  /** Filter every state snapshot before it crosses a seat boundary. */
  private playerState(state: State<any>, playerID: string | null): State<any> {
    const copy = JSON.parse(JSON.stringify(state));
    if (this.game.playerView) {
      copy.G = this.game.playerView({ G: copy.G, ctx: copy.ctx, playerID });
    }
    // History can contain earlier, unfiltered secrets. This transport does not
    // implement undo or redacted move logs, so never expose those snapshots.
    copy._undo = [];
    copy._redo = [];
    delete copy.deltalog;
    return copy;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async onUpdate(
    action: any,
    stateID: number,
    matchID: string,
    playerID: string,
  ): Promise<void | { error: string }> {
    // Wait for initialization to complete
    await this.initialized;

    if (matchID !== this.matchID) {
      return { error: "Match ID mismatch" };
    }

    const { state } = await this.db.fetch(matchID, { state: true });

    if (!state) {
      return { error: "Match not found" };
    }

    // Ensure playerID is on the action (boardgame.io stores it in payload).
    if (action?.payload && (action.payload.playerID == null || action.payload.playerID === "")) {
      action = {
        ...action,
        payload: { ...action.payload, playerID },
        playerID,
      };
    } else if (action && action.playerID == null) {
      action = { ...action, playerID };
    }

    const moveType = action?.payload?.type;
    const found = moveType
      ? findMove(this.game, moveType, state.ctx.phase)
      : null;
    const ignoreStale = !!(found && found.ignoreStaleStateID);

    // Concurrent crypto moves (key exchange, shuffle commit) race across peers.
    // Apply against latest state when the move opts into ignoreStaleStateID.
    if (state._stateID !== stateID) {
      if (!ignoreStale) {
        console.log(
          `[P2PMaster] Stale state: expected ${state._stateID}, got ${stateID} (move=${moveType}, player=${playerID})`,
        );
        return { error: "Stale state" };
      }
      console.log(
        `[P2PMaster] Accepting stale concurrent move ${moveType} from P${playerID} (client=${stateID}, master=${state._stateID})`,
      );
    }

    // Apply the action against the master's current state
    const newState = applyAction(this.game, state, action);

    if (newState === INVALID_MOVE) {
      console.log(
        `[P2PMaster] Invalid move ${moveType} from P${playerID} phase=${state.ctx.phase}`,
      );
      return { error: "Invalid move" };
    }

    // Save the new state
    await this.db.setState(matchID, newState);

    // Broadcast the update to all clients
    this.subscribers.forEach((callback, seat) => {
      callback({
        type: "update",
        args: [matchID, this.playerState(newState, seat), []],
      });
    });
  }

  async onSync(
    matchID: string,
    playerID: string | null,
    credentials?: string,
    numPlayers = 2,
  ): Promise<void | { error: string }> {
    // Wait for initialization to complete
    await this.initialized;

    if (matchID !== this.matchID) {
      return { error: "Match ID mismatch" };
    }

    const { state, initialState, metadata, log } = await this.db.fetch(
      matchID,
      { state: true, initialState: true, metadata: true, log: true },
    );
    console.log(
      "[P2PMaster] onSync - state:",
      state ? "present" : "null",
      "initialState:",
      initialState ? "present" : "null",
      "for player:",
      playerID,
    );

    if (!state) {
      return { error: "Match not found" };
    }

    const filteredMetadata = this.filterMetadata(metadata);

    // Send sync response to the requesting player
    // Include initialState as required by boardgame.io's SyncInfo interface
    const callback = this.subscribers.get(playerID || "spectator");
    if (callback) {
      callback({
        type: "sync",
        args: [
          matchID,
          {
            state: this.playerState(state, playerID),
            initialState: this.playerState(initialState || state, playerID),
            filteredMetadata,
            log: [],
          },
        ],
      });
    }
  }

  async onChatMessage(
    matchID: string,
    chatMessage: ChatMessage,
    credentials?: string,
  ): Promise<void> {
    // Broadcast chat to all subscribers
    this.notifyAll({
      type: "chat",
      args: [matchID, chatMessage],
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private filterMetadata(metadata: any): FilteredMetadata {
    if (!metadata?.players) {
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.entries(metadata.players).map(
      ([id, player]: [string, any]) => ({
        id: parseInt(id, 10),
        name: player?.name,
        isConnected: this.subscribers.has(id),
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getState(): Promise<State<any> | null> {
    const { state } = await this.db.fetch(this.matchID, { state: true });
    return state || null;
  }
}

/**
 * P2P Transport for boardgame.io
 *
 * This transport enables peer-to-peer multiplayer by:
 * - Having the host run an embedded game master
 * - Sending actions over WebRTC data channels
 * - Broadcasting state updates to connected peers
 *
 * Implements the Transport interface required by boardgame.io Client
 */
export class P2PTransport extends Transport {
  isConnected = false;
  /** Guest channel, or host 2p single-guest channel (legacy). */
  private connection: P2PChannel | null;
  /** Host multi-peer: playerID → guest channel. */
  private hostConnections: Map<string, P2PChannel>;
  private role: P2PRole;
  private master: P2PMaster | null = null;
  private messageBuffer: P2PMessage[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectionStatusCallbacks: Set<ConnectionStatusCallback> = new Set();

  // Properties expected by boardgame.io Client
  private game: Game;
  private setupData?: unknown;
  private restoreFromPersist: boolean;
  private assetSharingCallbacks: Set<(msg: AssetSharingMessage) => void> =
    new Set();

  constructor(
    opts: P2PTransportOpts & { transportDataCallback?: TransportDataCallback },
  ) {
    super({
      ...opts,
      gameName: opts.game.name || "unknown",
      transportDataCallback: opts.transportDataCallback ?? (() => {}),
    });
    this.role = opts.role;
    this.gameName = opts.game.name || "unknown";
    this.playerID = opts.playerID || null;
    this.matchID = opts.matchID || "default";
    this.credentials = opts.credentials;
    this.numPlayers = opts.numPlayers || 2;
    this.game = opts.game;
    this.setupData = opts.setupData;
    this.restoreFromPersist = !!opts.restoreFromPersist;

    // Normalize host multi-peer vs legacy single connection.
    if (opts.hostConnections && opts.hostConnections.size > 0) {
      this.hostConnections = new Map(opts.hostConnections);
      this.connection = opts.connection ?? null;
    } else if (opts.connection) {
      this.connection = opts.connection;
      this.hostConnections = new Map();
      if (opts.role === "host") {
        // Legacy 2p: treat single channel as guest "1".
        this.hostConnections.set("1", opts.connection);
      }
    } else {
      throw new Error(
        "P2PTransport requires connection and/or hostConnections",
      );
    }
  }

  /** Guest playerIDs the host currently has channels for. */
  private guestPlayerIDs(): string[] {
    return Array.from(this.hostConnections.keys());
  }

  private anyGuestConnected(): boolean {
    if (this.hostConnections.size === 0) {
      return this.connection?.isConnected() ?? false;
    }
    for (const ch of this.hostConnections.values()) {
      if (ch.isConnected()) return true;
    }
    return false;
  }

  subscribeToConnectionStatus(fn: ConnectionStatusCallback): () => void {
    this.connectionStatusCallbacks.add(fn);
    return () => this.connectionStatusCallbacks.delete(fn);
  }

  protected setConnectionStatus(connected: boolean): void {
    if (this.isConnected !== connected) {
      this.isConnected = connected;
      this.connectionStatusCallbacks.forEach((fn) => fn());
    }
  }

  protected notifyClient(data: P2PMessage): void {
    // Only engine response messages reach this boundary; extension messages
    // are routed separately by handleMessage.
    super.notifyClient(data as TransportData);
  }

  connect(): void {
    // Set up message handlers on all peer channels
    this.setupMessageHandlers();

    // Reflect current connection state immediately.
    // Host initialization is async; connectivity should not depend on it.
    const connected =
      this.role === "host"
        ? true // host master will run even if guests attach later
        : (this.connection?.isConnected() ?? false);
    this.setConnectionStatus(connected || this.anyGuestConnected());

    if (this.role === "host") {
      // connectAsHost is async, but connect() is called synchronously by boardgame.io
      // The async initialization will complete and trigger a sync
      this.connectAsHost().catch((err) => {
        console.error("[P2PTransport] Failed to connect as host:", err);
      });
    } else {
      this.connectAsGuest();
    }
  }

  private setupMessageHandlers(): void {
    const wired = new Set<P2PChannel>();

    const wire = (channel: P2PChannel, defaultPlayerID?: string) => {
      if (wired.has(channel)) return;
      wired.add(channel);
      const events = channel.events;
      if (!events) {
        console.error("[P2PTransport] Cannot access connection events");
        return;
      }

      const originalOnMessage = events.onMessage;
      events.onMessage = (data: string) => {
        try {
          const message: P2PMessage = JSON.parse(data);
          // Stamp guest playerID from channel map when host receives traffic
          if (
            this.role === "host" &&
            defaultPlayerID &&
            message.type === "action"
          ) {
            const args = message.args || [];
            if (args[3] == null) {
              message.args = [args[0], args[1], args[2], defaultPlayerID];
            }
          }
          if (
            this.role === "host" &&
            defaultPlayerID &&
            message.type === "sync-req"
          ) {
            const args = message.args || [];
            if (args[1] == null) {
              message.args = [args[0], defaultPlayerID, args[2], args[3]];
            }
          }
          this.handleMessage(message, defaultPlayerID);
        } catch (e) {
          console.error("[P2PTransport] Failed to parse message:", e);
        }
        originalOnMessage(data);
      };

      const originalOnConnectionStateChange = events.onConnectionStateChange;
      events.onConnectionStateChange = (state: ConnectionState) => {
        this.handleConnectionStateChange(state);
        originalOnConnectionStateChange(state);
      };
    };

    if (this.role === "host") {
      for (const [playerID, ch] of this.hostConnections) {
        wire(ch, playerID);
      }
    } else if (this.connection) {
      wire(this.connection);
    }
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    console.log("[P2PTransport] Connection state:", state);

    switch (state) {
      case "connected":
        this.setConnectionStatus(true);
        this.reconnectAttempts = 0;
        this.flushMessageBuffer();
        break;
      case "disconnected":
      case "failed":
        this.setConnectionStatus(false);
        this.attemptReconnect();
        break;
    }
  }

  private async connectAsHost(): Promise<void> {
    console.log("[P2PTransport] Connecting as host");

    // Create the master for the host (optionally restore board from localStorage)
    this.master = new P2PMaster(
      this.game,
      this.matchID,
      this.numPlayers,
      this.setupData,
      { restoreFromPersist: this.restoreFromPersist },
    );

    // Wait for the master to initialize the game state
    await this.master.waitForInit();
    console.log("[P2PTransport] Master initialized");

    // Subscribe the host's local client
    this.master.subscribe(this.playerID || "0", (data) => {
      console.log("[P2PTransport] Host received data:", data.type);
      this.notifyClient(data);
    });

    // Subscribe each guest playerID so master callbacks fan out per seat.
    // Do not also subscribe "remote" — notifyAll would double-deliver updates.
    for (const guestId of this.guestPlayerIDs()) {
      this.master.subscribe(guestId, (data) => {
        console.log(
          "[P2PTransport] Sending to guest",
          guestId,
          ":",
          data.type,
        );
        this.sendToGuest(data, guestId);
      });
    }

    this.setConnectionStatus(true);

    // Request initial sync for local client
    this.requestSync();

    // Proactively sync each connected guest after a short delay
    setTimeout(() => {
      if (!this.master) return;
      for (const guestId of this.guestPlayerIDs()) {
        const ch = this.hostConnections.get(guestId);
        if (ch?.isConnected()) {
          console.log("[P2PTransport] Proactively syncing guest", guestId);
          this.master.onSync(this.matchID, guestId, undefined, this.numPlayers);
        }
      }
    }, 100);
  }

  private connectAsGuest(): void {
    console.log("[P2PTransport] Connecting as guest");

    if (this.connection?.isConnected()) {
      this.setConnectionStatus(true);
      // Request sync from host
      this.sendToHost({
        type: "sync-req",
        args: [this.matchID, this.playerID, this.credentials, this.numPlayers],
      });
    }
  }

  private handleMessage(message: P2PMessage, fromPlayerID?: string): void {
    // Asset sharing messages are bidirectional — handle for both roles
    if (isAssetSharingMessage(message.type)) {
      this.handleAssetSharingMessage(message);
      return;
    }

    if (this.role === "host") {
      this.handleHostMessage(message, fromPlayerID);
    } else {
      this.handleGuestMessage(message);
    }
  }

  private handleHostMessage(
    message: P2PMessage,
    fromPlayerID?: string,
  ): void {
    if (!this.master) return;
    if (!fromPlayerID || !this.hostConnections.has(fromPlayerID)) return;
    if (!Array.isArray(message.args)) return;

    switch (message.type) {
      case "action": {
        let [action, stateID, matchID, playerID] = message.args;
        const pid = fromPlayerID;
        // A seat belongs to its connection, never to a field in guest input.
        if (
          (playerID != null && playerID !== pid) ||
          (action?.playerID != null && action.playerID !== pid) ||
          (action?.payload?.playerID != null && action.payload.playerID !== pid)
        ) {
          this.sendToGuest({ type: "error", args: ["Player ID mismatch"] }, pid);
          return;
        }
        if (!action || action.type !== "MAKE_MOVE" || !action.payload) return;

        // boardgame.io puts playerID on payload; also set top-level.
        if (action) {
          if (action.playerID == null) {
            action = { ...action, playerID: pid };
          }
          if (action.payload && action.payload.playerID == null) {
            action = {
              ...action,
              payload: { ...action.payload, playerID: pid },
            };
          }
        }
        this.master
          .onUpdate(action, stateID, matchID, pid)
          .then((result) => {
            if (result?.error) {
              this.sendToGuest(
                { type: "error", args: [result.error] },
                pid,
              );
            }
          });
        break;
      }

      case "sync-req": {
        const [syncMatchID, syncPlayerID, syncCredentials, syncNumPlayers] =
          message.args;
        if (!this.master) return;

        const guestId = fromPlayerID;
        if (syncPlayerID != null && syncPlayerID !== guestId) {
          this.sendToGuest({ type: "error", args: ["Player ID mismatch"] }, guestId);
          return;
        }
        console.log("[P2PTransport] Received sync-req from guest:", guestId);
        // Ensure this guest is subscribed for targeted updates
        if (!this.hostConnections.has(guestId) && this.connection) {
          // Legacy: already on "1"
        }
        this.master.onSync(
          syncMatchID,
          guestId,
          syncCredentials,
          syncNumPlayers,
        );
        break;
      }

      case "chat": {
        const [chatMatchID, chatMessage] = message.args;
        this.master.onChatMessage(chatMatchID, chatMessage, this.credentials);
        break;
      }
    }
  }

  private handleGuestMessage(message: P2PMessage): void {
    // Guest receives state updates and syncs from host
    switch (message.type) {
      case "update":
      case "sync":
      case "matchData":
      case "chat":
      case "patch":
        this.notifyClient(message);
        break;

      case "error": {
        const err = message.args?.[0];
        console.error("[P2PTransport] Host error:", err);
        // After a rejected concurrent move, re-sync so stateID catches up
        // and retries (e.g. submitPublicKey) can succeed.
        if (err === "Stale state" || err === "Invalid move") {
          this.requestSync();
        }
        break;
      }
    }
  }

  private sendToHost(message: P2PMessage): void {
    this.sendOnChannel(this.connection, message);
  }

  /** Send to one guest by playerID, or broadcast when playerID omitted. */
  private sendToGuest(message: P2PMessage, playerID?: string): void {
    if (playerID) {
      const ch = this.hostConnections.get(playerID);
      if (ch) {
        this.sendOnChannel(ch, message);
        return;
      }
    }
    this.broadcastToGuests(message);
  }

  private broadcastToGuests(message: P2PMessage): void {
    if (this.hostConnections.size === 0 && this.connection) {
      this.sendOnChannel(this.connection, message);
      return;
    }
    for (const ch of this.hostConnections.values()) {
      this.sendOnChannel(ch, message);
    }
  }

  private sendOnChannel(
    channel: P2PChannel | null,
    message: P2PMessage,
  ): void {
    if (!channel || !channel.isConnected()) {
      console.log("[P2PTransport] Buffering message while disconnected");
      this.messageBuffer.push(message);
      return;
    }

    try {
      channel.send(JSON.stringify(message));
    } catch (e) {
      console.error("[P2PTransport] Failed to send message:", e);
      this.messageBuffer.push(message);
    }
  }

  private flushMessageBuffer(): void {
    if (this.messageBuffer.length === 0) return;

    console.log(
      `[P2PTransport] Flushing ${this.messageBuffer.length} buffered messages`,
    );
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    for (const message of messages) {
      if (this.role === "guest") {
        this.sendToHost(message);
      } else {
        this.broadcastToGuests(message);
      }
    }
  }

  /**
   * Attempt to recover from a brief disconnection.
   *
   * Note: WebRTC connections can sometimes recover on their own if the
   * underlying network issue is brief. This method handles that case by:
   * 1. Waiting with exponential backoff
   * 2. Checking if the connection has recovered
   * 3. If recovered, flushing buffered messages and re-syncing
   *
   * For permanent disconnections (failed ICE, network change), the user
   * will need to re-establish the connection via a new join code exchange.
   * The UI shows connection status so users know when to reconnect.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        "[P2PTransport] Max reconnect attempts reached - connection lost",
      );
      console.log(
        "[P2PTransport] User should re-exchange join codes to reconnect",
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(
      `[P2PTransport] Waiting for connection recovery (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms`,
    );

    this.reconnectTimeout = setTimeout(() => {
      // Check if WebRTC connection has recovered on its own
      const recovered =
        this.role === "guest"
          ? (this.connection?.isConnected() ?? false)
          : this.anyGuestConnected();
      if (recovered) {
        console.log("[P2PTransport] Connection recovered");
        this.setConnectionStatus(true);
        this.reconnectAttempts = 0;
        this.flushMessageBuffer();

        // Guest should re-sync to get latest state after reconnect
        if (this.role === "guest") {
          this.sendToHost({
            type: "sync-req",
            args: [
              this.matchID,
              this.playerID,
              this.credentials,
              this.numPlayers,
            ],
          });
        }
      } else {
        // Still disconnected, try again
        this.attemptReconnect();
      }
    }, delay);
  }

  disconnect(): void {
    console.log("[P2PTransport] Disconnecting");

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.master) {
      this.master.unsubscribe(this.playerID || "0");
      // Unsubscribe every guest seat we subscribed (multi-peer + legacy "1")
      for (const guestId of this.guestPlayerIDs()) {
        this.master.unsubscribe(guestId);
      }
      // Legacy / defensive keys
      this.master.unsubscribe("1");
      this.master.unsubscribe("remote");
      this.master = null;
    }

    this.setConnectionStatus(false);
    this.messageBuffer = [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendAction(state: State<any>, action: any): void {
    const pid = this.playerID || "0";
    // boardgame.io stores playerID on payload; also set top-level for applyAction.
    if (action) {
      if (action.playerID == null) {
        action = { ...action, playerID: pid };
      }
      if (action.payload && action.payload.playerID == null) {
        action = {
          ...action,
          payload: { ...action.payload, playerID: pid },
        };
      }
    }

    console.log(
      "[P2PTransport] sendAction called:",
      action?.type,
      action?.payload?.type,
      "as P" + pid,
      "state:",
      state ? `stateID=${state._stateID}` : "null",
    );
    if (this.role === "host" && this.master) {
      // Host processes action locally
      this.master
        .onUpdate(action, state._stateID, this.matchID, pid)
        .then((result) => {
          if (result?.error) {
            console.error("[P2PTransport] Action failed:", result.error);
            // Host can still re-sync local client after rare races
            if (result.error === "Stale state") {
              this.requestSync();
            }
          } else {
            console.log("[P2PTransport] Action processed successfully");
          }
        });
    } else {
      // Guest sends action to host
      this.sendToHost({
        type: "action",
        args: [action, state._stateID, this.matchID, pid],
      });
    }
  }

  sendChatMessage(matchID: string, chatMessage: ChatMessage): void {
    const message: P2PMessage = {
      type: "chat",
      args: [matchID, chatMessage],
    };

    if (this.role === "host" && this.master) {
      this.master.onChatMessage(matchID, chatMessage, this.credentials);
    } else {
      this.sendToHost(message);
    }
  }

  requestSync(): void {
    console.log(
      "[P2PTransport] requestSync called, role:",
      this.role,
      "master:",
      this.master ? "present" : "null",
    );
    if (this.role === "host" && this.master) {
      this.master
        .onSync(this.matchID, this.playerID, this.credentials, this.numPlayers)
        .then(() => {
          console.log("[P2PTransport] Host sync complete");
        });
    } else {
      this.sendToHost({
        type: "sync-req",
        args: [this.matchID, this.playerID, this.credentials, this.numPlayers],
      });
    }
  }

  updateMatchID(matchID: string): void {
    this.matchID = matchID;
  }

  updatePlayerID(playerID: string | null): void {
    this.playerID = playerID;
  }

  updateCredentials(credentials?: string): void {
    this.credentials = credentials;
  }

  // --- Asset sharing protocol ---

  /** Subscribe to incoming asset sharing messages. Returns unsubscribe fn. */
  onAssetSharingMessage(
    callback: (msg: AssetSharingMessage) => void,
  ): () => void {
    this.assetSharingCallbacks.add(callback);
    return () => this.assetSharingCallbacks.delete(callback);
  }

  /** Send an asset sharing message to the peer(s). */
  sendAssetSharingMessage(msg: AssetSharingMessage): void {
    const message: P2PMessage = {
      type: msg.type as P2PMessageType,
      args: [msg],
    };
    if (this.role === "guest") {
      this.sendToHost(message);
    } else {
      this.broadcastToGuests(message);
    }
  }

  private handleAssetSharingMessage(message: P2PMessage): void {
    const msg = message.args[0] as AssetSharingMessage;
    this.assetSharingCallbacks.forEach((cb) => cb(msg));
  }
}

/**
 * Factory function to create a P2P multiplayer configuration
 * This is the function you pass to boardgame.io Client's multiplayer option
 */
export function P2PMultiplayer(opts: Omit<P2PTransportOpts, "game">) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (transportOpts: TransportOpts) => {
    return new P2PTransport({
      ...opts,
      game: transportOpts.game,
      transportDataCallback: transportOpts.transportDataCallback,
    });
  };
}

export type { ConnectionState, P2PChannel } from "./channel";
export type { AssetSharingMessage } from "./extension-messages";
export { isAssetSharingMessage } from "./extension-messages";
