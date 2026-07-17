/**
 * Optional extension message types that share the channel with game sync.
 * Asset-pack transfer is a ManaMesh feature; the transport only demuxes by type.
 */

export type AssetSharingMessageType =
  | "deck-list-share"
  | "deck-list-ack"
  | "asset-pack-request"
  | "asset-pack-offer"
  | "asset-pack-chunk"
  | "asset-pack-complete"
  | "asset-pack-denied"
  | "asset-pack-cancel";

/** Loose shape so apps can use richer typed messages. */
export type AssetSharingMessage = {
  type: AssetSharingMessageType | string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

const ASSET_SHARING_TYPES: readonly string[] = [
  "deck-list-share",
  "deck-list-ack",
  "asset-pack-request",
  "asset-pack-offer",
  "asset-pack-chunk",
  "asset-pack-complete",
  "asset-pack-denied",
  "asset-pack-cancel",
];

export function isAssetSharingMessage(
  type: string
): type is AssetSharingMessageType {
  return ASSET_SHARING_TYPES.includes(type);
}
