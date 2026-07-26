import {
  MANAMESH_HANDSHAKE_V,
  type ManameshHandshake,
} from "./types";

export type HandshakeRejectReason =
  | "bad_version"
  | "bad_role"
  | "game_id_mismatch"
  | "match_id_mismatch"
  | "second_host"
  | "table_full"
  | "invalid_payload";

export type HandshakeCheckResult =
  | { ok: true; handshake: ManameshHandshake }
  | { ok: false; reason: HandshakeRejectReason };

export function parseHandshake(data: unknown): HandshakeCheckResult {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "invalid_payload" };
  }
  const d = data as Record<string, unknown>;
  if (d.v !== MANAMESH_HANDSHAKE_V) {
    return { ok: false, reason: "bad_version" };
  }
  if (d.role !== "host" && d.role !== "guest") {
    return { ok: false, reason: "bad_role" };
  }
  if (typeof d.matchID !== "string" || !d.matchID) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (typeof d.gameId !== "string" || !d.gameId) {
    return { ok: false, reason: "invalid_payload" };
  }
  const hs: ManameshHandshake = {
    v: MANAMESH_HANDSHAKE_V,
    role: d.role,
    matchID: d.matchID,
    gameId: d.gameId,
  };
  if (typeof d.seat === "string") hs.seat = d.seat;
  if (typeof d.clientBuild === "string") hs.clientBuild = d.clientBuild;
  return { ok: true, handshake: hs };
}

/**
 * Host-side admission of a peer handshake.
 */
export function admitGuestHandshake(
  raw: unknown,
  opts: {
    gameId: string;
    matchID: string;
    hasHost: boolean;
    seatedCount: number;
    maxPlayers: number;
  },
): HandshakeCheckResult {
  const parsed = parseHandshake(raw);
  if (!parsed.ok) return parsed;
  const hs = parsed.handshake;
  if (hs.gameId !== opts.gameId) {
    return { ok: false, reason: "game_id_mismatch" };
  }
  if (hs.matchID !== opts.matchID) {
    return { ok: false, reason: "match_id_mismatch" };
  }
  if (hs.role === "host") {
    if (opts.hasHost) return { ok: false, reason: "second_host" };
  }
  if (hs.role === "guest") {
    // seatedCount includes host when hasHost
    if (opts.seatedCount >= opts.maxPlayers) {
      return { ok: false, reason: "table_full" };
    }
  }
  return { ok: true, handshake: hs };
}

export function buildHandshake(
  partial: Omit<ManameshHandshake, "v">,
): ManameshHandshake {
  return { v: MANAMESH_HANDSHAKE_V, ...partial };
}
