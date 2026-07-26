/** Optional peer dependency — only required when using ./trystero default joinRoom. */
declare module "trystero" {
  export function joinRoom(
    config: {
      appId: string;
      password?: string;
      turnConfig?: RTCIceServer[];
    },
    roomId: string,
    opts?: {
      onJoinError?: (details: unknown) => void;
    },
  ): {
    makeAction: <T = unknown>(
      name: string,
    ) => {
      send: (
        data: T,
        opts?: { target?: string },
      ) => Promise<unknown> | unknown;
      onProgress: ((...args: unknown[]) => void) | null;
      onMessage?:
        | ((data: T, meta: { peerId: string }) => void)
        | null;
    };
    leave: () => void;
    onPeerJoin: ((peerId: string) => void) | null;
    onPeerLeave: ((peerId: string) => void) | null;
  };
  export const selfId: string;
}
