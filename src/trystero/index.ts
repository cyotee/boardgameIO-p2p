/**
 * Optional Trystero discovery adapter for @cyotee/boardgameio-p2p.
 * Requires peer dependency `trystero` when using the default joinRoom
 * (omit joinRoomImpl). Channel transport does not import this module.
 */

export {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from "./room-code";

export {
  parseHandshake,
  admitGuestHandshake,
  buildHandshake,
} from "./handshake";

export {
  TrysteroChannel,
  TRYSTERO_BGIO_ACTION,
  TRYSTERO_HS_ACTION,
} from "./channel";

export { joinTrysteroTable } from "./table-session";

export type {
  ManameshHandshake,
  JoinTrysteroTableOpts,
  TrysteroTableSession,
  TrysteroTableRole,
  JoinRoomFn,
} from "./types";

export { MANAMESH_HANDSHAKE_V } from "./types";
