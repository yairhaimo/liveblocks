import type { DocumentVisibilityState } from "./compat/DocumentVisibilityState";
import type { ApplyResult, ManagedPool } from "./crdts/AbstractCrdt";
import { OpSource } from "./crdts/AbstractCrdt";
import {
  getTreesDiffOperations,
  isLiveList,
  isLiveNode,
  isSameNodeOrChildOf,
  mergeStorageUpdates,
} from "./crdts/liveblocks-helpers";
import { LiveObject } from "./crdts/LiveObject";
import type { LiveNode, LiveStructure, LsonObject } from "./crdts/Lson";
import type { StorageCallback, StorageUpdate } from "./crdts/StorageUpdates";
import { assertNever, nn } from "./lib/assert";
import { captureStackTrace } from "./lib/debug";
import type { Callback, Observable } from "./lib/EventSource";
import { makeEventSource } from "./lib/EventSource";
import * as console from "./lib/fancy-console";
import type { Json, JsonObject } from "./lib/Json";
import { isJsonArray, isJsonObject } from "./lib/Json";
import { asPos } from "./lib/position";
import type { Resolve } from "./lib/Resolve";
import { compact, isPlainObject, tryParseJson } from "./lib/utils";
import type { Authentication } from "./protocol/Authentication";
import type { JwtMetadata, RoomAuthToken } from "./protocol/AuthToken";
import {
  isTokenExpired,
  parseRoomAuthToken,
  RoomScope,
} from "./protocol/AuthToken";
import type { BaseUserMeta } from "./protocol/BaseUserMeta";
import type { ClientMsg } from "./protocol/ClientMsg";
import { ClientMsgCode } from "./protocol/ClientMsg";
import type { Op } from "./protocol/Op";
import { isAckOp, OpCode } from "./protocol/Op";
import type {
  IdTuple,
  SerializedChild,
  SerializedCrdt,
  SerializedRootObject,
} from "./protocol/SerializedCrdt";
import { isRootCrdt } from "./protocol/SerializedCrdt";
import type {
  InitialDocumentStateServerMsg,
  RoomStateServerMsg,
  ServerMsg,
  UpdatePresenceServerMsg,
  UserJoinServerMsg,
  UserLeftServerMsg,
} from "./protocol/ServerMsg";
import { ServerMsgCode } from "./protocol/ServerMsg";
import type { ImmutableRef } from "./refs/ImmutableRef";
import { MeRef } from "./refs/MeRef";
import { OthersRef } from "./refs/OthersRef";
import { DerivedRef, ValueRef } from "./refs/ValueRef";
import type * as DevTools from "./types/DevToolsTreeNode";
import type { NodeMap, ParentToChildNodeMap } from "./types/NodeMap";
import type { Others, OthersEvent } from "./types/Others";
import type { User } from "./types/User";
import { WebsocketCloseCodes } from "./types/WebsocketCloseCodes";

type TimeoutID = ReturnType<typeof setTimeout>;
type IntervalID = ReturnType<typeof setInterval>;

type CustomEvent<TRoomEvent extends Json> = {
  connectionId: number;
  event: TRoomEvent;
};

type AuthCallback = (room: string) => Promise<{ token: string }>;

export type Connection =
  /* The initial state, before connecting */
  | { status: "closed" }
  /* Authentication has started, but not finished yet */
  | { status: "authenticating" }
  /* Authentication succeeded, now attempting to connect to a room */
  | {
      status: "connecting";
      id: number;
      userId?: string;
      userInfo?: Json;
      isReadOnly: boolean;
    }
  /* Successful room connection, on the happy path */
  | {
      status: "open";
      id: number;
      userId?: string;
      userInfo?: Json;
      isReadOnly: boolean;
    }
  /* Connection lost unexpectedly, considered a temporary hiccup, will retry */
  | { status: "unavailable" }
  /* Connection failed due to known reason (e.g. rejected). Will throw error, then immediately jump to "unavailable" state, to attempt to reconnect */
  | { status: "failed" };

export type ConnectionStatus = Connection["status"];

export type StorageStatus =
  /* The storage is not loaded and has not been requested. */
  | "not-loaded"
  /* The storage is loading from Liveblocks servers */
  | "loading"
  /* Some storage modifications has not been acknowledged yet by the server */
  | "synchronizing"
  /* The storage is sync with Liveblocks servers */
  | "synchronized";

type RoomEventCallbackMap<
  TPresence extends JsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  event: Callback<CustomEvent<TRoomEvent>>;
  "my-presence": Callback<TPresence>;
  //
  // NOTE: OthersEventCallback is the only one not taking a Callback<T> shape,
  // since this API historically has taken _two_ callback arguments instead of
  // just one.
  others: (
    others: Others<TPresence, TUserMeta>,
    event: OthersEvent<TPresence, TUserMeta>
  ) => void;
  error: Callback<Error>;
  connection: Callback<ConnectionStatus>;
  history: Callback<HistoryEvent>;
  "storage-status": Callback<StorageStatus>;
};

export interface History {
  /**
   * Undoes the last operation executed by the current client.
   * It does not impact operations made by other clients.
   *
   * @example
   * room.updatePresence({ selectedId: "xx" }, { addToHistory: true });
   * room.updatePresence({ selectedId: "yy" }, { addToHistory: true });
   * room.history.undo();
   * // room.getPresence() equals { selectedId: "xx" }
   */
  undo: () => void;

  /**
   * Redoes the last operation executed by the current client.
   * It does not impact operations made by other clients.
   *
   * @example
   * room.updatePresence({ selectedId: "xx" }, { addToHistory: true });
   * room.updatePresence({ selectedId: "yy" }, { addToHistory: true });
   * room.history.undo();
   * // room.getPresence() equals { selectedId: "xx" }
   * room.history.redo();
   * // room.getPresence() equals { selectedId: "yy" }
   */
  redo: () => void;

  /**
   * Returns whether there are any operations to undo.
   *
   * @example
   * room.updatePresence({ selectedId: "xx" }, { addToHistory: true });
   * // room.history.canUndo() is true
   * room.history.undo();
   * // room.history.canUndo() is false
   */
  canUndo: () => boolean;

  /**
   * Returns whether there are any operations to redo.
   *
   * @example
   * room.updatePresence({ selectedId: "xx" }, { addToHistory: true });
   * room.history.undo();
   * // room.history.canRedo() is true
   * room.history.redo();
   * // room.history.canRedo() is false
   */
  canRedo: () => boolean;

  /**
   * All future modifications made on the Room will be merged together to create a single history item until resume is called.
   *
   * @example
   * room.updatePresence({ cursor: { x: 0, y: 0 } }, { addToHistory: true });
   * room.history.pause();
   * room.updatePresence({ cursor: { x: 1, y: 1 } }, { addToHistory: true });
   * room.updatePresence({ cursor: { x: 2, y: 2 } }, { addToHistory: true });
   * room.history.resume();
   * room.history.undo();
   * // room.getPresence() equals { cursor: { x: 0, y: 0 } }
   */
  pause: () => void;

  /**
   * Resumes history. Modifications made on the Room are not merged into a single history item anymore.
   *
   * @example
   * room.updatePresence({ cursor: { x: 0, y: 0 } }, { addToHistory: true });
   * room.history.pause();
   * room.updatePresence({ cursor: { x: 1, y: 1 } }, { addToHistory: true });
   * room.updatePresence({ cursor: { x: 2, y: 2 } }, { addToHistory: true });
   * room.history.resume();
   * room.history.undo();
   * // room.getPresence() equals { cursor: { x: 0, y: 0 } }
   */
  resume: () => void;
}

export type HistoryEvent = {
  canUndo: boolean;
  canRedo: boolean;
};

export type RoomEventName = Extract<
  keyof RoomEventCallbackMap<never, never, never>,
  string
>;

export type RoomEventCallbackFor<
  E extends RoomEventName,
  TPresence extends JsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = RoomEventCallbackMap<TPresence, TUserMeta, TRoomEvent>[E];

export type RoomEventCallback = RoomEventCallbackFor<
  RoomEventName,
  JsonObject,
  BaseUserMeta,
  Json
>;

export type BroadcastOptions = {
  /**
   * Whether or not event is queued if the connection is currently closed.
   *
   * ❗ We are not sure if we want to support this option in the future so it might be deprecated to be replaced by something else
   */
  shouldQueueEventIfNotReady: boolean;
};

export type Room<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  /**
   * The id of the room.
   */
  readonly id: string;
  /**
   * A client is considered "self aware" if it knows its own
   * metadata and connection ID (from the auth server).
   */
  isSelfAware(): boolean;
  getConnectionState(): ConnectionStatus;
  readonly subscribe: {
    /**
     * Subscribes to changes made on any Live structure. Returns an unsubscribe function.
     *
     * @internal This legacy API works, but was never documented publicly.
     */
    (callback: StorageCallback): () => void;

    /**
     * Subscribe to the current user presence updates.
     *
     * @param listener the callback that is called every time the current user presence is updated with {@link Room.updatePresence}.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * room.subscribe("my-presence", (presence) => {
     *   // Do something
     * });
     */
    (type: "my-presence", listener: Callback<TPresence>): () => void;

    /**
     * Subscribe to the other users updates.
     *
     * @param listener the callback that is called when a user enters or leaves the room or when a user update its presence.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * room.subscribe("others", (others) => {
     *   // Do something
     * });
     *
     */
    (
      type: "others",
      listener: (
        others: Others<TPresence, TUserMeta>,
        event: OthersEvent<TPresence, TUserMeta>
      ) => void
    ): () => void;

    /**
     * Subscribe to events broadcasted by {@link Room.broadcastEvent}
     *
     * @param listener the callback that is called when a user calls {@link Room.broadcastEvent}
     *
     * @returns Unsubscribe function.
     *
     * @example
     * room.subscribe("event", ({ event, connectionId }) => {
     *   // Do something
     * });
     *
     */
    (type: "event", listener: Callback<CustomEvent<TRoomEvent>>): () => void;

    /**
     * Subscribe to errors thrown in the room.
     *
     * @returns Unsubscribe function.
     *
     */
    (type: "error", listener: ErrorCallback): () => void;

    /**
     * Subscribe to connection state updates.
     *
     * @returns Unsubscribe function.
     *
     */
    (type: "connection", listener: Callback<ConnectionStatus>): () => void;

    /**
     * Subscribes to changes made on a Live structure. Returns an unsubscribe function.
     * In a future version, we will also expose what exactly changed in the Live structure.
     *
     * @param callback The callback this called when the Live structure changes.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * const liveMap = new LiveMap();  // Could also be LiveList or LiveObject
     * const unsubscribe = room.subscribe(liveMap, (liveMap) => { });
     * unsubscribe();
     */
    <L extends LiveStructure>(
      liveStructure: L,
      callback: (node: L) => void
    ): () => void;

    /**
     * Subscribes to changes made on a Live structure and all the nested data
     * structures. Returns an unsubscribe function. In a future version, we
     * will also expose what exactly changed in the Live structure.
     *
     * @param callback The callback this called when the Live structure, or any
     * of its nested values, changes.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * const liveMap = new LiveMap();  // Could also be LiveList or LiveObject
     * const unsubscribe = room.subscribe(liveMap, (updates) => { }, { isDeep: true });
     * unsubscribe();
     */
    <L extends LiveStructure>(
      liveStructure: L,
      callback: StorageCallback,
      options: { isDeep: true }
    ): () => void;

    /**
     * Subscribe to the current user's history changes.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * room.subscribe("history", ({ canUndo, canRedo }) => {
     *   // Do something
     * });
     */
    (type: "history", listener: Callback<HistoryEvent>): () => void;

    /**
     * Subscribe to storage status changes.
     *
     * @returns Unsubscribe function.
     *
     * @example
     * room.subscribe("storage-status", (status) => {
     *   switch(status) {
     *      case "not-loaded":
     *        break;
     *      case "loading":
     *        break;
     *      case "synchronizing":
     *        break;
     *      case "synchronized":
     *        break;
     *      default:
     *        break;
     *   }
     * });
     */
    (type: "storage-status", listener: Callback<StorageStatus>): () => void;
  };

  /**
   * Room's history contains functions that let you undo and redo operation made on by the current client on the presence and storage.
   */
  readonly history: History;

  /**
   * Gets the current user.
   * Returns null if not it is not yet connected to the room.
   *
   * @example
   * const user = room.getSelf();
   */
  getSelf(): User<TPresence, TUserMeta> | null;

  /**
   * Gets the presence of the current user.
   *
   * @example
   * const presence = room.getPresence();
   */
  getPresence(): TPresence;

  /**
   * Gets all the other users in the room.
   *
   * @example
   * const others = room.getOthers();
   */
  getOthers(): Others<TPresence, TUserMeta>;

  /**
   * Updates the presence of the current user. Only pass the properties you want to update. No need to send the full presence.
   * @param patch A partial object that contains the properties you want to update.
   * @param options Optional object to configure the behavior of updatePresence.
   *
   * @example
   * room.updatePresence({ x: 0 });
   * room.updatePresence({ y: 0 });
   *
   * const presence = room.getPresence();
   * // presence is equivalent to { x: 0, y: 0 }
   */
  updatePresence(
    patch: Partial<TPresence>,
    options?: {
      /**
       * Whether or not the presence should have an impact on the undo/redo history.
       */
      addToHistory: boolean;
    }
  ): void;

  /**
   * Broadcasts an event to other users in the room. Event broadcasted to the room can be listened with {@link Room.subscribe}("event").
   * @param {any} event the event to broadcast. Should be serializable to JSON
   *
   * @example
   * // On client A
   * room.broadcastEvent({ type: "EMOJI", emoji: "🔥" });
   *
   * // On client B
   * room.subscribe("event", ({ event }) => {
   *   if(event.type === "EMOJI") {
   *     // Do something
   *   }
   * });
   */
  broadcastEvent(event: TRoomEvent, options?: BroadcastOptions): void;

  /**
   * Get the room's storage asynchronously.
   * The storage's root is a {@link LiveObject}.
   *
   * @example
   * const { root } = await room.getStorage();
   */
  getStorage(): Promise<{
    root: LiveObject<TStorage>;
  }>;

  /**
   * Get the room's storage synchronously.
   * The storage's root is a {@link LiveObject}.
   *
   * @example
   * const root = room.getStorageSnapshot();
   */
  getStorageSnapshot(): LiveObject<TStorage> | null;

  readonly events: {
    customEvent: Observable<{ connectionId: number; event: TRoomEvent }>;
    me: Observable<TPresence>;
    others: Observable<{
      others: Others<TPresence, TUserMeta>;
      event: OthersEvent<TPresence, TUserMeta>;
    }>;
    error: Observable<Error>;
    connection: Observable<ConnectionStatus>;
    storage: Observable<StorageUpdate[]>;
    history: Observable<HistoryEvent>;
    /**
     * Subscribe to the storage loaded event. Will fire at most once during the
     * lifetime of a Room.
     */
    storageDidLoad: Observable<void>;
  };

  /**
   * Batches modifications made during the given function.
   * All the modifications are sent to other clients in a single message.
   * All the subscribers are called only after the batch is over.
   * All the modifications are merged in a single history item (undo/redo).
   *
   * @example
   * const { root } = await room.getStorage();
   * room.batch(() => {
   *   root.set("x", 0);
   *   room.updatePresence({ cursor: { x: 100, y: 100 }});
   * });
   */
  batch<T>(fn: () => T): T;

  /**
   * Get the storage status.
   *
   * - `not-loaded`: Initial state when entering the room.
   * - `loading`: Once the storage has been requested via room.getStorage().
   * - `synchronizing`: When some local updates have not been acknowledged by Liveblocks servers.
   * - `synchronized`: Storage is in sync with Liveblocks servers.
   */
  getStorageStatus(): StorageStatus;

  /**
   * Close room connection and try to reconnect
   */
  reconnect(): void;

  /**
   * @internal
   * Private methods to directly control the underlying state machine for this
   * room. Used in the core internals and for unit testing, but as a user of
   * Liveblocks, NEVER USE ANY OF THESE METHODS DIRECTLY, because bad things
   * will probably happen if you do.
   */
  readonly __internal: {
    connect(): void;
    disconnect(): void;
    onNavigatorOnline(): void;
    onVisibilityChange(visibilityState: DocumentVisibilityState): void;

    simulateCloseWebsocket(): void;
    simulateSendCloseEvent(event: {
      code: number;
      wasClean: boolean;
      reason: string;
    }): void;

    /** For DevTools support */
    getSelf_forDevTools(): DevTools.UserTreeNode | null;
    getOthers_forDevTools(): readonly DevTools.UserTreeNode[];
  };
};

type Machine<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  // Internal
  state: MachineContext<TPresence, TStorage, TUserMeta, TRoomEvent>;
  onClose(event: { code: number; wasClean: boolean; reason: string }): void;
  onMessage(event: MessageEvent<string>): void;
  authenticationSuccess(token: RoomAuthToken, socket: WebSocket): void;
  heartbeat(): void;
  onNavigatorOnline(): void;

  // Internal unit testing tools
  simulateSocketClose(): void;
  simulateSendCloseEvent(event: {
    code: number;
    wasClean: boolean;
    reason: string;
  }): void;

  // onWakeUp,
  onVisibilityChange(visibilityState: DocumentVisibilityState): void;
  getUndoStack(): HistoryOp<TPresence>[][];
  getItemsCount(): number;

  // Core
  connect(): void;
  disconnect(): void;
  reconnect(): void;

  // Presence
  updatePresence(
    patch: Partial<TPresence>,
    options?: { addToHistory: boolean }
  ): void;
  broadcastEvent(event: TRoomEvent, options?: BroadcastOptions): void;

  batch<T>(callback: () => T): T;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  pauseHistory(): void;
  resumeHistory(): void;

  getStorage(): Promise<{
    root: LiveObject<TStorage>;
  }>;
  getStorageSnapshot(): LiveObject<TStorage> | null;
  getStorageStatus(): StorageStatus;

  readonly events: {
    readonly customEvent: Observable<CustomEvent<TRoomEvent>>;
    readonly me: Observable<TPresence>;
    readonly others: Observable<{
      others: Others<TPresence, TUserMeta>;
      event: OthersEvent<TPresence, TUserMeta>;
    }>;
    readonly error: Observable<Error>;
    readonly connection: Observable<ConnectionStatus>;
    readonly storage: Observable<StorageUpdate[]>;
    readonly history: Observable<HistoryEvent>;
    readonly storageDidLoad: Observable<void>;
    readonly storageStatus: Observable<StorageStatus>;
  };

  // Core
  isSelfAware(): boolean;
  getConnectionState(): ConnectionStatus;
  getSelf(): User<TPresence, TUserMeta> | null;

  // Presence
  getPresence(): Readonly<TPresence>;
  getOthers(): Others<TPresence, TUserMeta>;

  // DevTools support
  getSelf_forDevTools(): DevTools.UserTreeNode | null;
  getOthers_forDevTools(): readonly DevTools.UserTreeNode[];
};

const BACKOFF_RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000, 10000];
const BACKOFF_RETRY_DELAYS_SLOW = [2000, 30000, 60000, 300000];

const HEARTBEAT_INTERVAL = 30000;
// const WAKE_UP_CHECK_INTERVAL = 2000;
const PONG_TIMEOUT = 2000;

function makeIdFactory(connectionId: number): IdFactory {
  let count = 0;
  return () => `${connectionId}:${count++}`;
}

function log(..._params: unknown[]) {
  // console.log(...params, new Date().toString());
  return;
}

function isConnectionSelfAware(
  connection: Connection
): connection is typeof connection & { status: "open" | "connecting" } {
  return connection.status === "open" || connection.status === "connecting";
}

type HistoryOp<TPresence extends JsonObject> =
  | Op
  | {
      readonly type: "presence";
      readonly data: TPresence;
    };

type IdFactory = () => string;

type MachineContext<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
> = {
  token: {
    readonly raw: string;
    readonly parsed: RoomAuthToken & JwtMetadata;
  } | null;
  lastConnectionId: number | null; // TODO: Move into Connection type members?
  socket: WebSocket | null;
  lastFlushTime: number;
  buffer: {
    // Queued-up "my presence" updates to be flushed at the earliest convenience
    me:
      | { type: "partial"; data: Partial<TPresence> }
      | { type: "full"; data: TPresence }
      | null;
    messages: ClientMsg<TPresence, TRoomEvent>[];
    storageOperations: Op[];
  };
  timeoutHandles: {
    flush: TimeoutID | undefined;
    reconnect: TimeoutID | undefined;
    pongTimeout: TimeoutID | undefined;
  };
  intervalHandles: {
    heartbeat: IntervalID | undefined;
  };

  readonly connection: ValueRef<Connection>;
  readonly me: MeRef<TPresence>;
  readonly others: OthersRef<TPresence, TUserMeta>;

  idFactory: IdFactory | null;
  numberOfRetry: number;
  initialStorage?: TStorage;

  clock: number;
  opClock: number;
  nodes: Map<string, LiveNode>;
  root: LiveObject<TStorage> | undefined;

  undoStack: HistoryOp<TPresence>[][];
  redoStack: HistoryOp<TPresence>[][];

  /**
   * When history is paused, all operations will get queued up here. When
   * history is resumed, these operations get "committed" to the undo stack.
   */
  pausedHistory: null | HistoryOp<TPresence>[];

  /**
   * Place to collect all mutations during a batch. Ops will be sent over the
   * wire after the batch is ended.
   */
  activeBatch: null | {
    ops: Op[];
    reverseOps: HistoryOp<TPresence>[];
    updates: {
      others: [];
      presence: boolean;
      storageUpdates: Map<string, StorageUpdate>;
    };
  };

  // A registry of yet-unacknowledged Ops. These Ops have already been
  // submitted to the server, but have not yet been acknowledged.
  unacknowledgedOps: Map<string, Op>;

  // Stack traces of all pending Ops. Used for debugging in non-production builds
  opStackTraces?: Map<string, string>;
};

/** @internal */
type Effects<TPresence extends JsonObject, TRoomEvent extends Json> = {
  authenticate(
    auth: AuthCallback,
    createWebSocket: (token: string) => WebSocket
  ): void;
  send(messages: ClientMsg<TPresence, TRoomEvent>[]): void;
  delayFlush(delay: number): TimeoutID;
  startHeartbeatInterval(): IntervalID;
  schedulePongTimeout(): TimeoutID;
  scheduleReconnect(delay: number): TimeoutID;
};

export type Polyfills = {
  atob?: (data: string) => string;
  fetch?: typeof fetch;
  WebSocket?: any;
};

export type RoomInitializers<
  TPresence extends JsonObject,
  TStorage extends LsonObject
> = Resolve<{
  /**
   * The initial Presence to use and announce when you enter the Room. The
   * Presence is available on all users in the Room (me & others).
   */
  initialPresence: TPresence | ((roomId: string) => TPresence);
  /**
   * The initial Storage to use when entering a new Room.
   */
  initialStorage?: TStorage | ((roomId: string) => TStorage);
  /**
   * Whether or not the room connects to Liveblock servers. Default is true.
   *
   * Usually set to false when the client is used from the server to not call
   * the authentication endpoint or connect via WebSocket.
   */
  shouldInitiallyConnect?: boolean;
}>;

/** @internal */
type MachineConfig<TPresence extends JsonObject, TRoomEvent extends Json> = {
  roomId: string;
  throttleDelay: number;
  authentication: Authentication;
  liveblocksServer: string;

  polyfills?: Polyfills;

  /**
   * Only necessary when you’re using Liveblocks with React v17 or lower.
   *
   * If so, pass in a reference to `ReactDOM.unstable_batchedUpdates` here.
   * This will allow Liveblocks to circumvent the so-called "zombie child
   * problem". To learn more, see
   * https://liveblocks.io/docs/guides/troubleshooting#stale-props-zombie-child
   */
  unstable_batchedUpdates?: (cb: () => void) => void;

  mockedEffects?: Effects<TPresence, TRoomEvent>;
};

function userToTreeNode(
  key: string,
  user: User<JsonObject, BaseUserMeta>
): DevTools.UserTreeNode {
  return {
    type: "User",
    id: `${user.connectionId}`,
    key,
    payload: user,
  };
}

function makeStateMachine<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  config: MachineConfig<TPresence, TRoomEvent>,
  initialPresence: TPresence,
  initialStorage: TStorage | undefined
): Machine<TPresence, TStorage, TUserMeta, TRoomEvent> {
  // The "context" is the machine's stateful extended context, also sometimes
  // known as the "extended state" of a finite state machine. The context
  // maintains state beyond the inherent state that are the finite states
  // themselves.
  const context: MachineContext<TPresence, TStorage, TUserMeta, TRoomEvent> = {
    token: null,
    lastConnectionId: null,
    socket: null,
    numberOfRetry: 0,
    lastFlushTime: 0,
    timeoutHandles: {
      flush: undefined,
      reconnect: undefined,
      pongTimeout: undefined,
    },
    buffer: {
      me:
        // Queue up the initial presence message as a Full Presence™ update
        {
          type: "full",
          data: initialPresence,
        },
      messages: [],
      storageOperations: [],
    },
    intervalHandles: {
      heartbeat: undefined,
    },

    connection: new ValueRef<Connection>({ status: "closed" }),
    me: new MeRef(initialPresence),
    others: new OthersRef<TPresence, TUserMeta>(),

    initialStorage,
    idFactory: null,

    // Storage
    clock: 0,
    opClock: 0,
    nodes: new Map<string, LiveNode>(),
    root: undefined,

    undoStack: [],
    redoStack: [],
    pausedHistory: null,

    activeBatch: null,
    unacknowledgedOps: new Map<string, Op>(),

    // Debug
    opStackTraces:
      process.env.NODE_ENV !== "production"
        ? new Map<string, string>()
        : undefined,
  };

  const doNotBatchUpdates = (cb: () => void): void => cb();
  const batchUpdates = config.unstable_batchedUpdates ?? doNotBatchUpdates;

  const pool: ManagedPool = {
    roomId: config.roomId,

    getNode: (id: string) => context.nodes.get(id),
    addNode: (id: string, node: LiveNode) => void context.nodes.set(id, node),
    deleteNode: (id: string) => void context.nodes.delete(id),

    generateId: () => `${getConnectionId()}:${context.clock++}`,
    generateOpId: () => `${getConnectionId()}:${context.opClock++}`,

    dispatch(
      ops: Op[],
      reverse: Op[],
      storageUpdates: Map<string, StorageUpdate>
    ) {
      const activeBatch = context.activeBatch;

      if (process.env.NODE_ENV !== "production") {
        const stackTrace = captureStackTrace("Storage mutation", this.dispatch);
        if (stackTrace) {
          ops.forEach((op) => {
            if (op.opId) {
              nn(context.opStackTraces).set(op.opId, stackTrace);
            }
          });
        }
      }

      if (activeBatch) {
        activeBatch.ops.push(...ops);
        storageUpdates.forEach((value, key) => {
          activeBatch.updates.storageUpdates.set(
            key,
            mergeStorageUpdates(
              activeBatch.updates.storageUpdates.get(key),
              value
            )
          );
        });
        activeBatch.reverseOps.unshift(...reverse);
      } else {
        batchUpdates(() => {
          addToUndoStack(reverse, doNotBatchUpdates);
          context.redoStack = [];
          dispatchOps(ops);
          notify({ storageUpdates }, doNotBatchUpdates);
        });
      }
    },

    assertStorageIsWritable: () => {
      if (
        isConnectionSelfAware(context.connection.current) &&
        context.connection.current.isReadOnly
      ) {
        throw new Error(
          "Cannot write to storage with a read only user, please ensure the user has write permissions"
        );
      }
    },
  };

  const eventHub = {
    customEvent: makeEventSource<CustomEvent<TRoomEvent>>(),
    me: makeEventSource<TPresence>(),
    others: makeEventSource<{
      others: Others<TPresence, TUserMeta>;
      event: OthersEvent<TPresence, TUserMeta>;
    }>(),
    error: makeEventSource<Error>(),
    connection: makeEventSource<ConnectionStatus>(),
    storage: makeEventSource<StorageUpdate[]>(),
    history: makeEventSource<HistoryEvent>(),
    storageDidLoad: makeEventSource<void>(),
    storageStatus: makeEventSource<StorageStatus>(),
  };

  const effects: Effects<TPresence, TRoomEvent> = config.mockedEffects || {
    authenticate(
      auth: AuthCallback,
      createWebSocket: (token: string) => WebSocket
    ) {
      // If we already have a parsed token from a previous connection
      // in-memory, reuse it
      const prevToken = context.token;
      if (prevToken !== null && !isTokenExpired(prevToken.parsed)) {
        const socket = createWebSocket(prevToken.raw);
        authenticationSuccess(prevToken.parsed, socket);
        return undefined;
      } else {
        return auth(config.roomId)
          .then(({ token }) => {
            if (context.connection.current.status !== "authenticating") {
              return;
            }
            const parsedToken = parseRoomAuthToken(token);
            const socket = createWebSocket(token);
            authenticationSuccess(parsedToken, socket);
            context.token = { raw: token, parsed: parsedToken };
          })
          .catch((er: unknown) =>
            authenticationFailure(
              er instanceof Error ? er : new Error(String(er))
            )
          );
      }
    },
    send(
      messageOrMessages:
        | ClientMsg<TPresence, TRoomEvent>
        | ClientMsg<TPresence, TRoomEvent>[]
    ) {
      if (context.socket === null) {
        throw new Error("Can't send message if socket is null");
      }
      context.socket.send(JSON.stringify(messageOrMessages));
    },
    delayFlush(delay: number) {
      return setTimeout(tryFlushing, delay);
    },
    startHeartbeatInterval() {
      return setInterval(heartbeat, HEARTBEAT_INTERVAL);
    },
    schedulePongTimeout() {
      return setTimeout(pongTimeout, PONG_TIMEOUT);
    },
    scheduleReconnect(delay: number) {
      return setTimeout(connect, delay);
    },
  };

  const self = new DerivedRef(
    context.connection,
    context.me,
    (conn, me): User<TPresence, TUserMeta> | null =>
      isConnectionSelfAware(conn)
        ? {
            connectionId: conn.id,
            id: conn.userId,
            info: conn.userInfo,
            presence: me,
            isReadOnly: conn.isReadOnly,
          }
        : null
  );

  // For use in DevTools
  const selfAsTreeNode = new DerivedRef(
    self as ImmutableRef<User<TPresence, TUserMeta> | null>,
    (me) => (me !== null ? userToTreeNode("Me", me) : null)
  );

  function createOrUpdateRootFromMessage(
    message: InitialDocumentStateServerMsg,
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    if (message.items.length === 0) {
      throw new Error("Internal error: cannot load storage without items");
    }

    if (context.root) {
      updateRoot(message.items, batchedUpdatesWrapper);
    } else {
      // TODO: For now, we'll assume the happy path, but reading this data from
      // the central storage server, it may very well turn out to not match the
      // manual type annotation. This will require runtime type validations!
      context.root = load(message.items) as LiveObject<TStorage>;
    }

    for (const key in context.initialStorage) {
      if (context.root.get(key) === undefined) {
        context.root.set(key, context.initialStorage[key]);
      }
    }
  }

  function buildRootAndParentToChildren(
    items: IdTuple<SerializedCrdt>[]
  ): [IdTuple<SerializedRootObject>, ParentToChildNodeMap] {
    const parentToChildren: ParentToChildNodeMap = new Map();
    let root: IdTuple<SerializedRootObject> | null = null;

    for (const [id, crdt] of items) {
      if (isRootCrdt(crdt)) {
        root = [id, crdt];
      } else {
        const tuple: IdTuple<SerializedChild> = [id, crdt];
        const children = parentToChildren.get(crdt.parentId);
        if (children !== undefined) {
          children.push(tuple);
        } else {
          parentToChildren.set(crdt.parentId, [tuple]);
        }
      }
    }

    if (root === null) {
      throw new Error("Root can't be null");
    }

    return [root, parentToChildren];
  }

  function updateRoot(
    items: IdTuple<SerializedCrdt>[],
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    if (!context.root) {
      return;
    }

    const currentItems: NodeMap = new Map();
    context.nodes.forEach((node, id) => {
      currentItems.set(id, node._serialize());
    });

    // Get operations that represent the diff between 2 states.
    const ops = getTreesDiffOperations(currentItems, new Map(items));

    const result = applyOps(ops, false);

    notify(result.updates, batchedUpdatesWrapper);
  }

  function load(items: IdTuple<SerializedCrdt>[]): LiveObject<LsonObject> {
    // TODO Abstract these details into a LiveObject._fromItems() helper?
    const [root, parentToChildren] = buildRootAndParentToChildren(items);
    return LiveObject._deserialize(root, parentToChildren, pool);
  }

  function _addToRealUndoStack(
    historyOps: HistoryOp<TPresence>[],
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    // If undo stack is too large, we remove the older item
    if (context.undoStack.length >= 50) {
      context.undoStack.shift();
    }

    context.undoStack.push(historyOps);
    onHistoryChange(batchedUpdatesWrapper);
  }

  function addToUndoStack(
    historyOps: HistoryOp<TPresence>[],
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    if (context.pausedHistory !== null) {
      context.pausedHistory.unshift(...historyOps);
    } else {
      _addToRealUndoStack(historyOps, batchedUpdatesWrapper);
    }
  }

  function notify(
    {
      storageUpdates = new Map<string, StorageUpdate>(),
      presence = false,
      others: otherEvents = [],
    }: {
      storageUpdates?: Map<string, StorageUpdate>;
      presence?: boolean;
      others?: OthersEvent<TPresence, TUserMeta>[];
    },
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    batchedUpdatesWrapper(() => {
      if (otherEvents.length > 0) {
        const others = context.others.current;
        for (const event of otherEvents) {
          eventHub.others.notify({ others, event });
        }
      }

      if (presence) {
        eventHub.me.notify(context.me.current);
      }

      if (storageUpdates.size > 0) {
        const updates = Array.from(storageUpdates.values());
        eventHub.storage.notify(updates);
      }
    });
  }

  function getConnectionId() {
    const conn = context.connection.current;
    if (isConnectionSelfAware(conn)) {
      return conn.id;
    } else if (context.lastConnectionId !== null) {
      return context.lastConnectionId;
    }

    throw new Error(
      "Internal. Tried to get connection id but connection was never open"
    );
  }

  function applyOps<O extends HistoryOp<TPresence>>(
    rawOps: readonly O[],
    isLocal: boolean
  ): {
    // Input Ops can get opIds assigned during application.
    ops: O[];
    reverse: O[];
    updates: {
      storageUpdates: Map<string, StorageUpdate>;
      presence: boolean;
    };
  } {
    const output = {
      reverse: [] as O[],
      storageUpdates: new Map<string, StorageUpdate>(),
      presence: false,
    };

    const createdNodeIds = new Set<string>();

    // Ops applied after undo/redo won't have opIds assigned, yet. Let's do
    // that right now first.
    const ops = rawOps.map((op) => {
      if (op.type !== "presence" && !op.opId) {
        return { ...op, opId: pool.generateOpId() };
      } else {
        return op;
      }
    });

    for (const op of ops) {
      if (op.type === "presence") {
        const reverse = {
          type: "presence" as const,
          data: {} as TPresence,
        };

        for (const key in op.data) {
          reverse.data[key] = context.me.current[key];
        }

        context.me.patch(op.data);

        if (context.buffer.me === null) {
          context.buffer.me = { type: "partial", data: op.data };
        } else {
          // Merge the new fields with whatever is already queued up (doesn't
          // matter whether its a partial or full update)
          for (const key in op.data) {
            context.buffer.me.data[key] = op.data[key];
          }
        }

        output.reverse.unshift(reverse as O);
        output.presence = true;
      } else {
        let source: OpSource;

        if (isLocal) {
          source = OpSource.UNDOREDO_RECONNECT;
        } else {
          const opId = nn(op.opId);
          if (process.env.NODE_ENV !== "production") {
            nn(context.opStackTraces).delete(opId);
          }

          const deleted = context.unacknowledgedOps.delete(opId);
          source = deleted ? OpSource.ACK : OpSource.REMOTE;
        }

        const applyOpResult = applyOp(op, source);
        if (applyOpResult.modified) {
          const nodeId = applyOpResult.modified.node._id;

          // If the modified node is not the root (undefined) and was created in the same batch, we don't want to notify
          // storage updates for the children.
          if (!(nodeId && createdNodeIds.has(nodeId))) {
            output.storageUpdates.set(
              nn(applyOpResult.modified.node._id),
              mergeStorageUpdates(
                output.storageUpdates.get(nn(applyOpResult.modified.node._id)),
                applyOpResult.modified
              )
            );
            output.reverse.unshift(...(applyOpResult.reverse as O[]));
          }

          if (
            op.type === OpCode.CREATE_LIST ||
            op.type === OpCode.CREATE_MAP ||
            op.type === OpCode.CREATE_OBJECT
          ) {
            createdNodeIds.add(nn(op.id));
          }
        }
      }
    }

    notifyStorageStatus();

    return {
      ops,
      reverse: output.reverse,
      updates: {
        storageUpdates: output.storageUpdates,
        presence: output.presence,
      },
    };
  }

  function applyOp(op: Op, source: OpSource): ApplyResult {
    // Explicit case to handle incoming "AckOp"s, which are supposed to be
    // no-ops.
    if (isAckOp(op)) {
      return { modified: false };
    }

    switch (op.type) {
      case OpCode.DELETE_OBJECT_KEY:
      case OpCode.UPDATE_OBJECT:
      case OpCode.DELETE_CRDT: {
        const node = context.nodes.get(op.id);
        if (node === undefined) {
          return { modified: false };
        }

        return node._apply(op, source === OpSource.UNDOREDO_RECONNECT);
      }

      case OpCode.SET_PARENT_KEY: {
        const node = context.nodes.get(op.id);
        if (node === undefined) {
          return { modified: false };
        }

        if (node.parent.type === "HasParent" && isLiveList(node.parent.node)) {
          return node.parent.node._setChildKey(
            asPos(op.parentKey),
            node,
            source
          );
        }
        return { modified: false };
      }
      case OpCode.CREATE_OBJECT:
      case OpCode.CREATE_LIST:
      case OpCode.CREATE_MAP:
      case OpCode.CREATE_REGISTER: {
        if (op.parentId === undefined) {
          return { modified: false };
        }

        const parentNode = context.nodes.get(op.parentId);
        if (parentNode === undefined) {
          return { modified: false };
        }

        return parentNode._attachChild(op, source);
      }
    }
  }

  function connect() {
    if (
      context.connection.current.status !== "closed" &&
      context.connection.current.status !== "unavailable"
    ) {
      return;
    }

    const auth = prepareAuthEndpoint(
      config.authentication,
      config.polyfills?.fetch
    );
    const createWebSocket = prepareCreateWebSocket(
      config.liveblocksServer,
      config.polyfills?.WebSocket
    );

    updateConnection({ status: "authenticating" }, batchUpdates);
    effects.authenticate(auth, createWebSocket);
  }

  function updatePresence(
    patch: Partial<TPresence>,
    options?: { addToHistory: boolean }
  ) {
    const oldValues = {} as TPresence;

    if (context.buffer.me === null) {
      context.buffer.me = {
        type: "partial",
        data: {},
      };
    }

    for (const key in patch) {
      type K = typeof key;
      const overrideValue: TPresence[K] | undefined = patch[key];
      if (overrideValue === undefined) {
        continue;
      }
      context.buffer.me.data[key] = overrideValue;
      oldValues[key] = context.me.current[key];
    }

    context.me.patch(patch);

    if (context.activeBatch) {
      if (options?.addToHistory) {
        context.activeBatch.reverseOps.unshift({
          type: "presence",
          data: oldValues,
        });
      }
      context.activeBatch.updates.presence = true;
    } else {
      tryFlushing();
      batchUpdates(() => {
        if (options?.addToHistory) {
          addToUndoStack(
            [{ type: "presence", data: oldValues }],
            doNotBatchUpdates
          );
        }
        notify({ presence: true }, doNotBatchUpdates);
      });
    }
  }

  function isStorageReadOnly(scopes: string[]) {
    return (
      scopes.includes(RoomScope.Read) &&
      scopes.includes(RoomScope.PresenceWrite) &&
      !scopes.includes(RoomScope.Write)
    );
  }

  function authenticationSuccess(token: RoomAuthToken, socket: WebSocket) {
    socket.addEventListener("message", onMessage);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);

    updateConnection(
      {
        status: "connecting",
        id: token.actor,
        userInfo: token.info,
        userId: token.id,
        isReadOnly: isStorageReadOnly(token.scopes),
      },
      batchUpdates
    );
    context.idFactory = makeIdFactory(token.actor);
    context.socket = socket;
  }

  function authenticationFailure(error: Error) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Call to authentication endpoint failed", error);
    }
    context.token = null;
    updateConnection({ status: "unavailable" }, batchUpdates);
    context.numberOfRetry++;
    context.timeoutHandles.reconnect = effects.scheduleReconnect(
      getRetryDelay()
    );
  }

  function onVisibilityChange(visibilityState: DocumentVisibilityState) {
    if (
      visibilityState === "visible" &&
      context.connection.current.status === "open"
    ) {
      log("Heartbeat after visibility change");
      heartbeat();
    }
  }

  function onUpdatePresenceMessage(
    message: UpdatePresenceServerMsg<TPresence>
  ): OthersEvent<TPresence, TUserMeta> | undefined {
    if (message.targetActor !== undefined) {
      // The incoming message is a full presence update. We are obliged to
      // handle it if `targetActor` matches our own connection ID, but we can
      // use the opportunity to effectively reset the known presence as
      // a "keyframe" update, while we have free access to it.
      const oldUser = context.others.getUser(message.actor);
      context.others.setOther(message.actor, message.data);

      const newUser = context.others.getUser(message.actor);
      if (oldUser === undefined && newUser !== undefined) {
        // The user just became "visible" due to this update, so fire the
        // "enter" event
        return { type: "enter", user: newUser };
      }
    } else {
      // The incoming message is a partial presence update
      context.others.patchOther(message.actor, message.data), message;
    }

    const user = context.others.getUser(message.actor);
    if (user) {
      return {
        type: "update",
        updates: message.data,
        user,
      };
    } else {
      return undefined;
    }
  }

  function onUserLeftMessage(
    message: UserLeftServerMsg
  ): OthersEvent<TPresence, TUserMeta> | null {
    const user = context.others.getUser(message.actor);
    if (user) {
      context.others.removeConnection(message.actor);
      return { type: "leave", user };
    }
    return null;
  }

  function onRoomStateMessage(
    message: RoomStateServerMsg<TUserMeta>
  ): OthersEvent<TPresence, TUserMeta> {
    for (const connectionId in context.others._connections) {
      const user = message.users[connectionId];
      if (user === undefined) {
        context.others.removeConnection(Number(connectionId));
      }
    }

    for (const key in message.users) {
      const user = message.users[key];
      const connectionId = Number(key);
      context.others.setConnection(
        connectionId,
        user.id,
        user.info,
        isStorageReadOnly(user.scopes)
      );
    }
    return { type: "reset" };
  }

  function onNavigatorOnline() {
    if (context.connection.current.status === "unavailable") {
      log("Try to reconnect after connectivity change");
      reconnect();
    }
  }

  function onHistoryChange(batchedUpdatesWrapper: (cb: () => void) => void) {
    batchedUpdatesWrapper(() => {
      eventHub.history.notify({ canUndo: canUndo(), canRedo: canRedo() });
    });
  }

  function onUserJoinedMessage(
    message: UserJoinServerMsg<TUserMeta>
  ): OthersEvent<TPresence, TUserMeta> | undefined {
    context.others.setConnection(
      message.actor,
      message.id,
      message.info,
      isStorageReadOnly(message.scopes)
    );
    // Send current presence to new user
    // TODO: Consider storing it on the backend
    context.buffer.messages.push({
      type: ClientMsgCode.UPDATE_PRESENCE,
      data: context.me.current,
      targetActor: message.actor,
    });
    tryFlushing();

    // We recorded the connection, but we won't make the new user visible
    // unless we also know their initial presence data at this point.
    const user = context.others.getUser(message.actor);
    return user ? { type: "enter", user } : undefined;
  }

  function parseServerMessage(
    data: Json
  ): ServerMsg<TPresence, TUserMeta, TRoomEvent> | null {
    if (!isJsonObject(data)) {
      return null;
    }

    return data as ServerMsg<TPresence, TUserMeta, TRoomEvent>;
    //          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ FIXME: Properly validate incoming external data instead!
  }

  function parseServerMessages(
    text: string
  ): ServerMsg<TPresence, TUserMeta, TRoomEvent>[] | null {
    const data: Json | undefined = tryParseJson(text);
    if (data === undefined) {
      return null;
    } else if (isJsonArray(data)) {
      return compact(data.map((item) => parseServerMessage(item)));
    } else {
      return compact([parseServerMessage(data)]);
    }
  }

  function onMessage(event: MessageEvent<string>) {
    if (event.data === "pong") {
      clearTimeout(context.timeoutHandles.pongTimeout);
      return;
    }

    const messages = parseServerMessages(event.data);
    if (messages === null || messages.length === 0) {
      // istanbul ignore next: Unknown incoming message
      return;
    }

    const updates = {
      storageUpdates: new Map<string, StorageUpdate>(),
      others: [] as OthersEvent<TPresence, TUserMeta>[],
    };

    batchUpdates(() => {
      for (const message of messages) {
        switch (message.type) {
          case ServerMsgCode.USER_JOINED: {
            const userJoinedUpdate = onUserJoinedMessage(message);
            if (userJoinedUpdate) {
              updates.others.push(userJoinedUpdate);
            }
            break;
          }

          case ServerMsgCode.UPDATE_PRESENCE: {
            const othersPresenceUpdate = onUpdatePresenceMessage(message);
            if (othersPresenceUpdate) {
              updates.others.push(othersPresenceUpdate);
            }
            break;
          }

          case ServerMsgCode.BROADCASTED_EVENT: {
            eventHub.customEvent.notify({
              connectionId: message.actor,
              event: message.event,
            });
            break;
          }

          case ServerMsgCode.USER_LEFT: {
            const event = onUserLeftMessage(message);
            if (event) {
              updates.others.push(event);
            }
            break;
          }

          case ServerMsgCode.ROOM_STATE: {
            updates.others.push(onRoomStateMessage(message));
            break;
          }

          case ServerMsgCode.INITIAL_STORAGE_STATE: {
            // createOrUpdateRootFromMessage function could add ops to offlineOperations.
            // Client shouldn't resend these ops as part of the offline ops sending after reconnect.
            const unacknowledgedOps = new Map(context.unacknowledgedOps);
            createOrUpdateRootFromMessage(message, doNotBatchUpdates);
            applyAndSendOps(unacknowledgedOps, doNotBatchUpdates);
            if (_getInitialStateResolver !== null) {
              _getInitialStateResolver();
            }
            notifyStorageStatus();
            eventHub.storageDidLoad.notify();
            break;
          }
          // Write event
          case ServerMsgCode.UPDATE_STORAGE: {
            const applyResult = applyOps(message.ops, false);
            applyResult.updates.storageUpdates.forEach((value, key) => {
              updates.storageUpdates.set(
                key,
                mergeStorageUpdates(updates.storageUpdates.get(key), value)
              );
            });

            break;
          }

          // Receiving a RejectedOps message in the client means that the server is no
          // longer in sync with the client. Trying to synchronize the client again by
          // rolling back particular Ops may be hard/impossible. It's fine to not try and
          // accept the out-of-sync reality and throw an error. We look at this kind of bug
          // as a developer-owned bug. In production, these errors are not expected to happen.
          case ServerMsgCode.REJECT_STORAGE_OP: {
            console.errorWithTitle(
              "Storage mutation rejection error",
              message.reason
            );

            if (process.env.NODE_ENV !== "production") {
              const traces: Set<string> = new Set();
              for (const opId of message.opIds) {
                const trace = context.opStackTraces?.get(opId);
                if (trace) {
                  traces.add(trace);
                }
              }

              if (traces.size > 0) {
                console.warnWithTitle(
                  "The following function calls caused the rejected storage mutations:",
                  `\n\n${Array.from(traces).join("\n\n")}`
                );
              }

              throw new Error(
                `Storage mutations rejected by server: ${message.reason}`
              );
            }

            break;
          }
        }
      }

      notify(updates, doNotBatchUpdates);
    });
  }

  function onClose(event: { code: number; wasClean: boolean; reason: string }) {
    context.socket = null;

    clearTimeout(context.timeoutHandles.pongTimeout);
    clearInterval(context.intervalHandles.heartbeat);
    if (context.timeoutHandles.flush) {
      clearTimeout(context.timeoutHandles.flush);
    }
    clearTimeout(context.timeoutHandles.reconnect);

    context.others.clearOthers();

    batchUpdates(() => {
      notify({ others: [{ type: "reset" }] }, doNotBatchUpdates);

      if (event.code >= 4000 && event.code <= 4100) {
        updateConnection({ status: "failed" }, doNotBatchUpdates);

        const error = new LiveblocksError(event.reason, event.code);
        eventHub.error.notify(error);

        const delay = getRetryDelay(true);
        context.numberOfRetry++;

        if (process.env.NODE_ENV !== "production") {
          console.error(
            `Connection to websocket server closed. Reason: ${error.message} (code: ${error.code}). Retrying in ${delay}ms.`
          );
        }

        updateConnection({ status: "unavailable" }, doNotBatchUpdates);
        context.timeoutHandles.reconnect = effects.scheduleReconnect(delay);
      } else if (event.code === WebsocketCloseCodes.CLOSE_WITHOUT_RETRY) {
        updateConnection({ status: "closed" }, doNotBatchUpdates);
      } else {
        const delay = getRetryDelay();
        context.numberOfRetry++;

        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `Connection to Liveblocks websocket server closed (code: ${event.code}). Retrying in ${delay}ms.`
          );
        }
        updateConnection({ status: "unavailable" }, doNotBatchUpdates);
        context.timeoutHandles.reconnect = effects.scheduleReconnect(delay);
      }
    });
  }

  function updateConnection(
    connection: Connection,
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    context.connection.set(connection);
    batchedUpdatesWrapper(() => {
      eventHub.connection.notify(connection.status);
    });
  }

  function getRetryDelay(slow: boolean = false) {
    if (slow) {
      return BACKOFF_RETRY_DELAYS_SLOW[
        context.numberOfRetry < BACKOFF_RETRY_DELAYS_SLOW.length
          ? context.numberOfRetry
          : BACKOFF_RETRY_DELAYS_SLOW.length - 1
      ];
    }
    return BACKOFF_RETRY_DELAYS[
      context.numberOfRetry < BACKOFF_RETRY_DELAYS.length
        ? context.numberOfRetry
        : BACKOFF_RETRY_DELAYS.length - 1
    ];
  }

  function onError() {}

  function onOpen() {
    clearInterval(context.intervalHandles.heartbeat);

    context.intervalHandles.heartbeat = effects.startHeartbeatInterval();

    if (context.connection.current.status === "connecting") {
      updateConnection(
        { ...context.connection.current, status: "open" },
        batchUpdates
      );
      context.numberOfRetry = 0;

      // Re-broadcast the user presence during a reconnect.
      if (context.lastConnectionId !== undefined) {
        context.buffer.me = {
          type: "full",
          data:
            // Because state.me.current is a readonly object, we'll have to
            // make a copy here. Otherwise, type errors happen later when
            // "patching" my presence.
            { ...context.me.current },
        };
        tryFlushing();
      }

      context.lastConnectionId = context.connection.current.id;

      if (context.root) {
        context.buffer.messages.push({ type: ClientMsgCode.FETCH_STORAGE });
      }
      tryFlushing();
    } else {
      // TODO
    }
  }

  function heartbeat() {
    if (context.socket === null) {
      // Should never happen, because we clear the pong timeout when the connection is dropped explictly
      return;
    }

    clearTimeout(context.timeoutHandles.pongTimeout);
    context.timeoutHandles.pongTimeout = effects.schedulePongTimeout();

    if (context.socket.readyState === context.socket.OPEN) {
      context.socket.send("ping");
    }
  }

  function pongTimeout() {
    log("Pong timeout. Trying to reconnect.");
    reconnect();
  }

  function reconnect() {
    if (context.socket) {
      context.socket.removeEventListener("open", onOpen);
      context.socket.removeEventListener("message", onMessage);
      context.socket.removeEventListener("close", onClose);
      context.socket.removeEventListener("error", onError);
      context.socket.close();
      context.socket = null;
    }

    updateConnection({ status: "unavailable" }, batchUpdates);
    clearTimeout(context.timeoutHandles.pongTimeout);
    if (context.timeoutHandles.flush) {
      clearTimeout(context.timeoutHandles.flush);
    }
    clearTimeout(context.timeoutHandles.reconnect);
    clearInterval(context.intervalHandles.heartbeat);
    connect();
  }

  function applyAndSendOps(
    offlineOps: Map<string, Op>,
    batchedUpdatesWrapper: (cb: () => void) => void
  ) {
    if (offlineOps.size === 0) {
      return;
    }

    const messages: ClientMsg<TPresence, TRoomEvent>[] = [];

    const ops = Array.from(offlineOps.values());

    const result = applyOps(ops, true);

    messages.push({
      type: ClientMsgCode.UPDATE_STORAGE,
      ops: result.ops,
    });

    notify(result.updates, batchedUpdatesWrapper);

    effects.send(messages);
  }

  function tryFlushing() {
    const storageOps = context.buffer.storageOperations;

    if (storageOps.length > 0) {
      storageOps.forEach((op) => {
        context.unacknowledgedOps.set(nn(op.opId), op);
      });
      notifyStorageStatus();
    }

    if (
      context.socket === null ||
      context.socket.readyState !== context.socket.OPEN
    ) {
      context.buffer.storageOperations = [];
      return;
    }

    const now = Date.now();

    const elapsedTime = now - context.lastFlushTime;

    if (elapsedTime > config.throttleDelay) {
      const messages = flushDataToMessages(context);

      if (messages.length === 0) {
        return;
      }
      effects.send(messages);
      context.buffer = {
        messages: [],
        storageOperations: [],
        me: null,
      };
      context.lastFlushTime = now;
    } else {
      if (context.timeoutHandles.flush !== null) {
        clearTimeout(context.timeoutHandles.flush);
      }

      context.timeoutHandles.flush = effects.delayFlush(
        config.throttleDelay - (now - context.lastFlushTime)
      );
    }
  }

  function flushDataToMessages(
    state: MachineContext<TPresence, TStorage, TUserMeta, TRoomEvent>
  ) {
    const messages: ClientMsg<TPresence, TRoomEvent>[] = [];
    if (state.buffer.me) {
      messages.push(
        state.buffer.me.type === "full"
          ? {
              type: ClientMsgCode.UPDATE_PRESENCE,
              // Populating the `targetActor` field turns this message into
              // a Full Presence™ update message (not a patch), which will get
              // interpreted by other clients as such.
              targetActor: -1,
              data: state.buffer.me.data,
            }
          : {
              type: ClientMsgCode.UPDATE_PRESENCE,
              data: state.buffer.me.data,
            }
      );
    }
    for (const event of state.buffer.messages) {
      messages.push(event);
    }
    if (state.buffer.storageOperations.length > 0) {
      messages.push({
        type: ClientMsgCode.UPDATE_STORAGE,
        ops: state.buffer.storageOperations,
      });
    }
    return messages;
  }

  function disconnect() {
    if (context.socket) {
      context.socket.removeEventListener("open", onOpen);
      context.socket.removeEventListener("message", onMessage);
      context.socket.removeEventListener("close", onClose);
      context.socket.removeEventListener("error", onError);
      context.socket.close();
      context.socket = null;
    }

    batchUpdates(() => {
      updateConnection({ status: "closed" }, doNotBatchUpdates);

      if (context.timeoutHandles.flush) {
        clearTimeout(context.timeoutHandles.flush);
      }
      clearTimeout(context.timeoutHandles.reconnect);
      clearTimeout(context.timeoutHandles.pongTimeout);
      clearInterval(context.intervalHandles.heartbeat);

      context.others.clearOthers();
      notify({ others: [{ type: "reset" }] }, doNotBatchUpdates);

      // Clear all event listeners
      Object.values(eventHub).forEach((eventSource) => eventSource.clear());
    });
  }

  function broadcastEvent(
    event: TRoomEvent,
    options: BroadcastOptions = {
      shouldQueueEventIfNotReady: false,
    }
  ) {
    if (context.socket === null && !options.shouldQueueEventIfNotReady) {
      return;
    }

    context.buffer.messages.push({
      type: ClientMsgCode.BROADCAST_EVENT,
      event,
    });
    tryFlushing();
  }

  function dispatchOps(ops: Op[]) {
    context.buffer.storageOperations.push(...ops);
    tryFlushing();
  }

  let _getInitialStatePromise: Promise<void> | null = null;
  let _getInitialStateResolver: (() => void) | null = null;

  function startLoadingStorage(): Promise<void> {
    if (_getInitialStatePromise === null) {
      context.buffer.messages.push({ type: ClientMsgCode.FETCH_STORAGE });
      tryFlushing();
      _getInitialStatePromise = new Promise(
        (resolve) => (_getInitialStateResolver = resolve)
      );
      notifyStorageStatus();
    }
    return _getInitialStatePromise;
  }

  /**
   * Closely related to .getStorage(), but synchronously. Will be `null`
   * initially. When requested for the first time, will kick off the loading of
   * Storage if it hasn't happened yet.
   *
   * Once Storage is loaded, will return a stable reference to the storage
   * root.
   */
  function getStorageSnapshot(): LiveObject<TStorage> | null {
    const root = context.root;
    if (root !== undefined) {
      // Done loading
      return root;
    } else {
      // Not done loading, kick off the loading (will not do anything if already kicked off)
      startLoadingStorage();
      return null;
    }
  }

  async function getStorage(): Promise<{
    root: LiveObject<TStorage>;
  }> {
    if (context.root) {
      // Store has already loaded, so we can resolve it directly
      return Promise.resolve({
        root: context.root as LiveObject<TStorage>,
      });
    }

    await startLoadingStorage();
    return {
      root: nn(context.root) as LiveObject<TStorage>,
    };
  }

  function undo() {
    if (context.activeBatch) {
      throw new Error("undo is not allowed during a batch");
    }
    const historyOps = context.undoStack.pop();
    if (historyOps === undefined) {
      return;
    }

    context.pausedHistory = null;
    const result = applyOps(historyOps, true);

    batchUpdates(() => {
      notify(result.updates, doNotBatchUpdates);
      context.redoStack.push(result.reverse);
      onHistoryChange(doNotBatchUpdates);
    });

    for (const op of result.ops) {
      if (op.type !== "presence") {
        context.buffer.storageOperations.push(op);
      }
    }
    tryFlushing();
  }

  function canUndo() {
    return context.undoStack.length > 0;
  }

  function redo() {
    if (context.activeBatch) {
      throw new Error("redo is not allowed during a batch");
    }

    const historyOps = context.redoStack.pop();
    if (historyOps === undefined) {
      return;
    }

    context.pausedHistory = null;
    const result = applyOps(historyOps, true);

    batchUpdates(() => {
      notify(result.updates, doNotBatchUpdates);
      context.undoStack.push(result.reverse);
      onHistoryChange(doNotBatchUpdates);
    });

    for (const op of result.ops) {
      if (op.type !== "presence") {
        context.buffer.storageOperations.push(op);
      }
    }
    tryFlushing();
  }

  function canRedo() {
    return context.redoStack.length > 0;
  }

  function batch<T>(callback: () => T): T {
    if (context.activeBatch) {
      // If there already is an active batch, we don't have to handle this in
      // any special way. That outer active batch will handle the batch. This
      // nested call can be a no-op.
      return callback();
    }

    let returnValue: T = undefined as unknown as T;

    batchUpdates(() => {
      context.activeBatch = {
        ops: [],
        updates: {
          storageUpdates: new Map(),
          presence: false,
          others: [],
        },
        reverseOps: [],
      };
      try {
        returnValue = callback();
      } finally {
        // "Pop" the current batch of the state, closing the active batch, but
        // handling it separately here
        const currentBatch = context.activeBatch;
        context.activeBatch = null;

        if (currentBatch.reverseOps.length > 0) {
          addToUndoStack(currentBatch.reverseOps, doNotBatchUpdates);
        }

        if (currentBatch.ops.length > 0) {
          // Only clear the redo stack if something has changed during a batch
          // Clear the redo stack because batch is always called from a local operation
          context.redoStack = [];
        }

        if (currentBatch.ops.length > 0) {
          dispatchOps(currentBatch.ops);
        }

        notify(currentBatch.updates, doNotBatchUpdates);
        tryFlushing();
      }
    });

    return returnValue;
  }

  function pauseHistory() {
    context.pausedHistory = [];
  }

  function resumeHistory() {
    const historyOps = context.pausedHistory;
    context.pausedHistory = null;
    if (historyOps !== null && historyOps.length > 0) {
      _addToRealUndoStack(historyOps, batchUpdates);
    }
  }

  function simulateSocketClose() {
    if (context.socket) {
      context.socket = null;
    }
  }

  function simulateSendCloseEvent(event: {
    code: number;
    wasClean: boolean;
    reason: string;
  }) {
    onClose(event);
  }

  function getStorageStatus(): StorageStatus {
    if (_getInitialStatePromise === null) {
      return "not-loaded";
    }

    if (context.root === undefined) {
      return "loading";
    }

    return context.unacknowledgedOps.size === 0
      ? "synchronized"
      : "synchronizing";
  }

  /**
   * Storage status is a computed value based other internal states so we need to keep a reference to the previous computed value to avoid triggering events when it does not change
   * This is far from ideal because we need to call this function whenever we update our internal states.
   *
   * TODO: Encapsulate our internal state differently to make sure this event is triggered whenever necessary.
   * Currently okay because we only have 4 callers and shielded by tests.
   */
  let _lastStorageStatus = getStorageStatus();
  function notifyStorageStatus() {
    const storageStatus = getStorageStatus();
    if (_lastStorageStatus !== storageStatus) {
      _lastStorageStatus = storageStatus;
      eventHub.storageStatus.notify(storageStatus);
    }
  }

  // Derived cached state for use in DevTools
  const others_forDevTools = new DerivedRef(context.others, (others) =>
    others.map((other, index) => userToTreeNode(`Other ${index}`, other))
  );

  return {
    // Internal
    get state() {
      return context;
    },
    onClose,
    onMessage,
    authenticationSuccess,
    heartbeat,
    onNavigatorOnline,
    // Internal DevTools
    simulateSocketClose,
    simulateSendCloseEvent,
    onVisibilityChange,
    getUndoStack: () => context.undoStack,
    getItemsCount: () => context.nodes.size,

    // Core
    connect,
    disconnect,
    reconnect,

    // Presence
    updatePresence,
    broadcastEvent,

    // Storage
    batch,
    undo,
    redo,
    canUndo,
    canRedo,
    pauseHistory,
    resumeHistory,

    getStorage,
    getStorageSnapshot,
    getStorageStatus,

    events: {
      customEvent: eventHub.customEvent.observable,
      others: eventHub.others.observable,
      me: eventHub.me.observable,
      error: eventHub.error.observable,
      connection: eventHub.connection.observable,
      storage: eventHub.storage.observable,
      history: eventHub.history.observable,
      storageDidLoad: eventHub.storageDidLoad.observable,
      storageStatus: eventHub.storageStatus.observable,
    },

    // Core
    getConnectionState: () => context.connection.current.status,
    isSelfAware: () => isConnectionSelfAware(context.connection.current),
    getSelf: () => self.current,

    // Presence
    getPresence: () => context.me.current,
    getOthers: () => context.others.current,

    // Support for the Liveblocks browser extension
    getSelf_forDevTools: () => selfAsTreeNode.current,
    getOthers_forDevTools: (): readonly DevTools.UserTreeNode[] =>
      others_forDevTools.current,
  };
}

/**
 * Initializes a new Room state machine, and returns its public API to observe
 * and control it.
 */
export function createRoom<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  options: Omit<
    RoomInitializers<TPresence, TStorage>,
    "shouldInitiallyConnect"
  >,
  config: MachineConfig<TPresence, TRoomEvent>
): Room<TPresence, TStorage, TUserMeta, TRoomEvent> {
  const { initialPresence, initialStorage } = options;

  const machine = makeStateMachine<TPresence, TStorage, TUserMeta, TRoomEvent>(
    config,
    typeof initialPresence === "function"
      ? initialPresence(config.roomId)
      : initialPresence,
    typeof initialStorage === "function"
      ? initialStorage(config.roomId)
      : initialStorage
  );

  const room: Room<TPresence, TStorage, TUserMeta, TRoomEvent> = {
    id: config.roomId,
    /////////////
    // Core    //
    /////////////
    getConnectionState: machine.getConnectionState,
    isSelfAware: machine.isSelfAware,
    getSelf: machine.getSelf,
    reconnect: machine.reconnect,

    subscribe: makeClassicSubscribeFn(machine),

    //////////////
    // Presence //
    //////////////
    getPresence: machine.getPresence,
    updatePresence: machine.updatePresence,
    getOthers: machine.getOthers,
    broadcastEvent: machine.broadcastEvent,

    //////////////
    // Storage  //
    //////////////
    getStorage: machine.getStorage,
    getStorageSnapshot: machine.getStorageSnapshot,
    getStorageStatus: machine.getStorageStatus,
    events: machine.events,

    batch: machine.batch,
    history: {
      undo: machine.undo,
      redo: machine.redo,
      canUndo: machine.canUndo,
      canRedo: machine.canRedo,
      pause: machine.pauseHistory,
      resume: machine.resumeHistory,
    },

    __internal: {
      connect: machine.connect,
      disconnect: machine.disconnect,
      onNavigatorOnline: machine.onNavigatorOnline,
      onVisibilityChange: machine.onVisibilityChange,

      simulateCloseWebsocket: machine.simulateSocketClose,
      simulateSendCloseEvent: machine.simulateSendCloseEvent,

      getSelf_forDevTools: machine.getSelf_forDevTools,
      getOthers_forDevTools: machine.getOthers_forDevTools,
    },
  };

  return room;
}

/**
 * This recreates the classic single `.subscribe()` method for the Room API, as
 * documented here https://liveblocks.io/docs/api-reference/liveblocks-client#Room.subscribe(storageItem)
 */
export function makeClassicSubscribeFn<
  TPresence extends JsonObject,
  TStorage extends LsonObject,
  TUserMeta extends BaseUserMeta,
  TRoomEvent extends Json
>(
  machine: Machine<TPresence, TStorage, TUserMeta, TRoomEvent>
): Room<TPresence, TStorage, TUserMeta, TRoomEvent>["subscribe"] {
  // Set up the "subscribe" wrapper API
  function subscribeToLiveStructureDeeply<L extends LiveStructure>(
    node: L,
    callback: (updates: StorageUpdate[]) => void
  ): () => void {
    return machine.events.storage.subscribe((updates) => {
      const relatedUpdates = updates.filter((update) =>
        isSameNodeOrChildOf(update.node, node)
      );
      if (relatedUpdates.length > 0) {
        callback(relatedUpdates);
      }
    });
  }

  function subscribeToLiveStructureShallowly<L extends LiveStructure>(
    node: L,
    callback: (node: L) => void
  ): () => void {
    return machine.events.storage.subscribe((updates) => {
      for (const update of updates) {
        if (update.node._id === node._id) {
          callback(update.node as L);
        }
      }
    });
  }

  // Generic storage callbacks
  function subscribe(callback: StorageCallback): () => void; // prettier-ignore
  // Storage callbacks filtered by Live structure
  function subscribe<L extends LiveStructure>(liveStructure: L, callback: (node: L) => void): () => void; // prettier-ignore
  function subscribe(node: LiveStructure, callback: StorageCallback, options: { isDeep: true }): () => void; // prettier-ignore
  // Room event callbacks
  function subscribe<E extends RoomEventName>(type: E, listener: RoomEventCallbackFor<E, TPresence, TUserMeta, TRoomEvent>): () => void; // prettier-ignore

  function subscribe<L extends LiveStructure, E extends RoomEventName>(
    first: StorageCallback | L | E,
    second?: ((node: L) => void) | StorageCallback | RoomEventCallback,
    options?: { isDeep: boolean }
  ): () => void {
    if (typeof first === "string" && isRoomEventName(first)) {
      if (typeof second !== "function") {
        throw new Error("Second argument must be a callback function");
      }
      const callback = second;
      switch (first) {
        case "event":
          return machine.events.customEvent.subscribe(
            callback as Callback<CustomEvent<TRoomEvent>>
          );

        case "my-presence":
          return machine.events.me.subscribe(callback as Callback<TPresence>);

        case "others": {
          // NOTE: Others have a different callback structure, where the API
          // exposed on the outside takes _two_ callback arguments!
          const cb = callback as (
            others: Others<TPresence, TUserMeta>,
            event: OthersEvent<TPresence, TUserMeta>
          ) => void;
          return machine.events.others.subscribe(({ others, event }) =>
            cb(others, event)
          );
        }

        case "error":
          return machine.events.error.subscribe(callback as Callback<Error>);

        case "connection":
          return machine.events.connection.subscribe(
            callback as Callback<ConnectionStatus>
          );

        case "storage":
          return machine.events.storage.subscribe(
            callback as Callback<StorageUpdate[]>
          );

        case "history":
          return machine.events.history.subscribe(
            callback as Callback<HistoryEvent>
          );

        case "storage-status":
          return machine.events.storageStatus.subscribe(
            callback as Callback<StorageStatus>
          );

        // istanbul ignore next
        default:
          return assertNever(first, "Unknown event");
      }
    }

    if (second === undefined || typeof first === "function") {
      if (typeof first === "function") {
        const storageCallback = first;
        return machine.events.storage.subscribe(storageCallback);
      } else {
        // istanbul ignore next
        throw new Error("Please specify a listener callback");
      }
    }

    if (isLiveNode(first)) {
      const node = first;
      if (options?.isDeep) {
        const storageCallback = second as StorageCallback;
        return subscribeToLiveStructureDeeply(node, storageCallback);
      } else {
        const nodeCallback = second as (node: L) => void;
        return subscribeToLiveStructureShallowly(node, nodeCallback);
      }
    }

    throw new Error(`"${first}" is not a valid event name`);
  }

  return subscribe;
}

function isRoomEventName(value: string): value is RoomEventName {
  return (
    value === "my-presence" ||
    value === "others" ||
    value === "event" ||
    value === "error" ||
    value === "connection" ||
    value === "history" ||
    value === "storage-status"
  );
}

class LiveblocksError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

function prepareCreateWebSocket(
  liveblocksServer: string,
  WebSocketPolyfill?: typeof WebSocket
) {
  if (typeof window === "undefined" && WebSocketPolyfill === undefined) {
    throw new Error(
      "To use Liveblocks client in a non-dom environment, you need to provide a WebSocket polyfill."
    );
  }

  const ws = WebSocketPolyfill || WebSocket;

  return (token: string): WebSocket => {
    return new ws(
      `${liveblocksServer}/?token=${token}&version=${
        // prettier-ignore
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore (__PACKAGE_VERSION__ will be injected by the build script)
        typeof __PACKAGE_VERSION__ === "string" ? /* istanbul ignore next */ __PACKAGE_VERSION__ : "dev"
      }`
    );
  };
}

function prepareAuthEndpoint(
  authentication: Authentication,
  fetchPolyfill?: typeof window.fetch
): AuthCallback {
  if (authentication.type === "public") {
    if (typeof window === "undefined" && fetchPolyfill === undefined) {
      throw new Error(
        "To use Liveblocks client in a non-dom environment with a publicApiKey, you need to provide a fetch polyfill."
      );
    }

    return (room: string) =>
      fetchAuthEndpoint(
        fetchPolyfill || /* istanbul ignore next */ fetch,
        authentication.url,
        {
          room,
          publicApiKey: authentication.publicApiKey,
        }
      );
  }

  if (authentication.type === "private") {
    if (typeof window === "undefined" && fetchPolyfill === undefined) {
      throw new Error(
        "To use Liveblocks client in a non-dom environment with a url as auth endpoint, you need to provide a fetch polyfill."
      );
    }

    return (room: string) =>
      fetchAuthEndpoint(fetchPolyfill || fetch, authentication.url, {
        room,
      });
  }

  if (authentication.type === "custom") {
    return async (room: string) => {
      const response = await authentication.callback(room);
      if (!response || !response.token) {
        throw new Error(
          'Authentication error. We expect the authentication callback to return a token, but it does not. Hint: the return value should look like: { token: "..." }'
        );
      }
      return response;
    };
  }

  throw new Error("Internal error. Unexpected authentication type");
}

async function fetchAuthEndpoint(
  fetch: typeof window.fetch,
  endpoint: string,
  body: {
    room: string;
    publicApiKey?: string;
  }
): Promise<{ token: string }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    // Credentials are needed to support authentication with cookies
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AuthenticationError(
      `Expected a status 200 but got ${res.status} when doing a POST request on "${endpoint}"`
    );
  }
  let data: Json;
  try {
    data = await (res.json() as Promise<Json>);
  } catch (er) {
    throw new AuthenticationError(
      `Expected a JSON response when doing a POST request on "${endpoint}". ${er}`
    );
  }
  if (!isPlainObject(data) || typeof data.token !== "string") {
    throw new AuthenticationError(
      `Expected a JSON response of the form \`{ token: "..." }\` when doing a POST request on "${endpoint}", but got ${JSON.stringify(
        data
      )}`
    );
  }
  const { token } = data;
  return { token };
}

class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
  }
}

//
// These exports are considered private implementation details and only
// exported here to be accessed used in our test suite.
//
export { makeStateMachine as _private_makeStateMachine };
export type { Effects as _private_Effects, Machine as _private_Machine };
