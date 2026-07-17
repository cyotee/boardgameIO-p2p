/**
 * Loose boardgame.io typings for package builds when dist/types is missing.
 * Runtime still uses real boardgame.io; consumers get proper types from their install.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "boardgame.io" {
  export type Game = any;
  export type State<T = any> = any;
  export type Ctx = any;
  export type PlayerID = string;
  export type LogEntry = any;
  export type ChatMessage = any;
  export type FilteredMetadata = any;
  export namespace CredentialedActionShape {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type Any = any;
  }
  export namespace Server {
    export type MatchData = any;
  }
  export namespace StorageAPI {
    export type CreateMatchOpts = any;
    export type FetchOpts = any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export type FetchResult<T = any> = any;
    export type FetchFields = any;
  }
  const _default: any;
  export default _default;
}

declare module "boardgame.io/core" {
  export const INVALID_MOVE: unique symbol;
  export type INVALID_MOVE = typeof INVALID_MOVE;
}

declare module "boardgame.io/internal" {
  export class Transport {
    constructor(opts?: any);
    protected matchID: string;
    protected playerID: string | null;
    protected credentials?: string;
    protected gameName: string;
    protected numPlayers: number;
    protected notifyClient(data: any): void;
    protected setConnectionStatus(connected: boolean): void;
  }
  export function createMatch(opts: any): any;
  export function getFilterPlayerView(game: any): any;
  export const Sync: any;
  export type Any = any;
}

declare module "boardgame.io/master" {
  export class Master {
    constructor(...args: any[]);
    onUpdate(...args: any[]): Promise<any>;
    onSync(...args: any[]): Promise<any>;
    onChatMessage(...args: any[]): Promise<any>;
    onConnectionChange(...args: any[]): Promise<any>;
  }
}

declare module "boardgame.io/client" {
  export function Client(opts: any): any;
}
