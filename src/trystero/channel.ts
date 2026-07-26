import type {
  ConnectionState,
  P2PChannel,
  P2PChannelEvents,
} from "../channel";

export const TRYSTERO_BGIO_ACTION = "manamesh-bgio";
export const TRYSTERO_HS_ACTION = "manamesh-hs";

/**
 * Minimal action surface used by TrysteroChannel (real trystero makeAction shape).
 */
export type ActionBus<T = string> = {
  send: (data: T, opts?: { target?: string }) => void | Promise<unknown>;
  /** Assigned by consumers; trystero invokes on inbound */
  onProgress?:
    | ((percent: number, peerId: string, metadata?: unknown) => void)
    | null;
};

/**
 * Adapts a Trystero action targeted at one peer into {@link P2PChannel}.
 */
export class TrysteroChannel implements P2PChannel {
  readonly events: P2PChannelEvents;
  private connected = false;
  private readonly action: ActionBus<string>;
  private readonly targetPeerId: string;
  private readonly onInbound: (handler: (data: string, peerId: string) => void) => void;

  constructor(opts: {
    targetPeerId: string;
    /** bgio action bus */
    action: ActionBus<string>;
    /**
     * Register a listener for messages on this action.
     * Called once; should invoke handler for each inbound message.
     */
    subscribeMessages: (
      handler: (data: string, peerId: string) => void,
    ) => void;
    initiallyConnected?: boolean;
  }) {
    this.targetPeerId = opts.targetPeerId;
    this.action = opts.action;
    this.connected = opts.initiallyConnected !== false;
    this.events = {
      onMessage: () => {},
      onConnectionStateChange: () => {},
    };
    this.onInbound = opts.subscribeMessages;
    this.onInbound((data, peerId) => {
      if (peerId !== this.targetPeerId) return;
      this.events.onMessage(data);
    });
  }

  send(data: string): void {
    if (!this.connected) {
      throw new Error("TrysteroChannel not connected");
    }
    void this.action.send(data, { target: this.targetPeerId });
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Mark peer leave / ICE failure */
  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    const state: ConnectionState = connected ? "connected" : "disconnected";
    this.events.onConnectionStateChange(state);
  }

  get peerId(): string {
    return this.targetPeerId;
  }
}
