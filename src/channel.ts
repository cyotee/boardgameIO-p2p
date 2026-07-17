/**
 * Abstract peer data channel used by the channel-based P2P transport.
 *
 * Implementations include ManaMesh join-code WebRTC connections (and can include
 * LAN / relay adapters). The transport only needs send, connectivity, and event hooks.
 */

/** Connection lifecycle states (aligned with WebRTC peer wrappers). */
export type ConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

/**
 * Event bag on a channel. The transport wraps `onMessage` / `onConnectionStateChange`
 * when it connects (same pattern as the original in-app JoinCodeConnection).
 */
export interface P2PChannelEvents {
  onMessage: (data: string) => void;
  onConnectionStateChange: (state: ConnectionState) => void;
}

/**
 * Minimal channel interface for {@link P2PMultiplayer} / channel {@link P2PTransport}.
 *
 * - `send` / `isConnected` — data path
 * - `events` — message + connection state hooks (mutable; transport may wrap handlers)
 */
export interface P2PChannel {
  send(data: string): void;
  isConnected(): boolean;
  /** Required for transport message wiring. */
  events: P2PChannelEvents;
}
