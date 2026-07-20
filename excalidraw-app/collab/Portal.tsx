import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { encryptData } from "@excalidraw/excalidraw/data/encryption";
import { newElementWith } from "@excalidraw/element";
import throttle from "lodash.throttle";

import type { UserIdleState } from "@excalidraw/common";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  OnUserFollowedPayload,
  SocketId,
} from "@excalidraw/excalidraw/types";

import { WS_EVENTS, FILE_UPLOAD_TIMEOUT, WS_SUBTYPES } from "../app_constants";
import { isSyncableElement } from "../data";
import {
  assertVaultAdmissionToken,
  VAULT_SOCKET_EVENTS,
  VaultError,
} from "../data/vault";

import type {
  SocketUpdateData,
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";
import type { VaultAdmission, VaultRealtimeSession } from "../data/vault";
import type { TCollabClass } from "./Collab";
import type { Socket } from "socket.io-client";

class Portal {
  collab: TCollabClass;
  socket: Socket | null = null;
  socketInitialized: boolean = false; // we don't want the socket to emit any updates until it is fully initialized
  roomId: string | null = null;
  roomKey: string | null = null;
  vaultRealtimeSession: VaultRealtimeSession | null = null;
  private vaultBroadcastQueue: Promise<void> = Promise.resolve();
  broadcastedElementVersions: Map<string, number> = new Map();

  constructor(collab: TCollabClass) {
    this.collab = collab;
  }

  private initializeLegacySocketListeners() {
    this.socket?.on("init-room", () => {
      if (this.socket) {
        this.socket.emit("join-room", this.roomId);
        trackEvent("share", "room joined");
      }
    });
    this.socket?.on("new-user", async (_socketId: string) => {
      this.broadcastScene(
        WS_SUBTYPES.INIT,
        this.collab.getSceneElementsIncludingDeleted(),
        /* syncAll */ true,
      );
    });
    this.socket?.on("room-user-change", (clients: SocketId[]) => {
      this.collab.setCollaborators(clients);
    });
  }

  open(socket: Socket, id: string, key: string) {
    this.vaultRealtimeSession?.destroy();
    this.vaultRealtimeSession = null;
    this.socket = socket;
    this.roomId = id;
    this.roomKey = key;
    this.initializeLegacySocketListeners();

    return socket;
  }

  /**
   * Attaches a socket after the F2 capability admission handshake succeeds.
   * Unlike ordinary collaboration, this never emits the legacy `join-room`.
   */
  openVaultTransport(
    admission: VaultAdmission,
    socket: Socket,
    session: VaultRealtimeSession,
  ) {
    assertVaultAdmissionToken(admission);
    if (
      session.vaultId !== admission.vaultId ||
      session.role !== admission.role ||
      session.senderSessionId !== admission.senderSessionId
    ) {
      throw new VaultError(
        "VAULT_CAPABILITY_INVALID",
        "Vault realtime session does not match its admission.",
      );
    }
    this.vaultRealtimeSession?.destroy();
    this.socket = socket;
    this.roomId = admission.activeRoomId;
    this.roomKey = null;
    this.vaultRealtimeSession = session;
    return socket;
  }

  close() {
    if (!this.socket) {
      return;
    }
    if (this.vaultRealtimeSession) {
      this.queueFileUpload.cancel();
    } else {
      this.queueFileUpload.flush();
    }
    this.socket.close();
    this.socket = null;
    this.roomId = null;
    this.roomKey = null;
    this.vaultRealtimeSession?.destroy();
    this.vaultRealtimeSession = null;
    this.vaultBroadcastQueue = Promise.resolve();
    this.socketInitialized = false;
    this.broadcastedElementVersions = new Map();
  }

  isOpen() {
    return !!(
      this.socketInitialized &&
      this.socket &&
      this.roomId &&
      (this.roomKey || this.vaultRealtimeSession)
    );
  }

  async _broadcastSocketData(
    data: SocketUpdateData,
    volatile: boolean = false,
    roomId?: string,
  ) {
    if (data.type === WS_SUBTYPES.INVALID_RESPONSE) {
      return;
    }

    if (this.isOpen()) {
      if (this.vaultRealtimeSession) {
        const session = this.vaultRealtimeSession;
        // Vault follow relationships stay encrypted. Viewport presence is
        // broadcast to the main Vault room and filtered by recipients instead
        // of using the legacy plaintext `follow@<socketId>` routing room.
        const targetRoomId = this.roomId;
        const socket = this.socket;
        const event = volatile
          ? VAULT_SOCKET_EVENTS.serverVolatile
          : VAULT_SOCKET_EVENTS.server;
        const task = this.vaultBroadcastQueue.then(async () => {
          const envelope = await session.encrypt(data);
          if (
            this.vaultRealtimeSession !== session ||
            this.socket !== socket ||
            !this.isOpen()
          ) {
            return;
          }
          socket?.emit(event, targetRoomId, envelope);
        });
        this.vaultBroadcastQueue = task.catch(() => undefined);
        return task;
      }

      const json = JSON.stringify(data);
      const encoded = new TextEncoder().encode(json);
      const { encryptedBuffer, iv } = await encryptData(this.roomKey!, encoded);

      this.socket?.emit(
        volatile ? WS_EVENTS.SERVER_VOLATILE : WS_EVENTS.SERVER,
        roomId ?? this.roomId,
        encryptedBuffer,
        iv,
      );
    }
  }

  queueFileUpload = throttle(async () => {
    // Vault assets use the dedicated encrypted asset service. The ordinary
    // FileManager is never reachable while a Vault transport is attached.
    const fileManager = this.vaultRealtimeSession
      ? this.collab.vaultFileManager
      : this.collab.fileManager;
    if (!fileManager) {
      if (this.vaultRealtimeSession) {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: "Vault encrypted asset service is unavailable.",
            viewModeEnabled: true,
          },
        });
      }
      return;
    }

    try {
      await fileManager.saveFiles({
        elements: this.collab.excalidrawAPI.getSceneElementsIncludingDeleted(),
        files: this.collab.excalidrawAPI.getFiles(),
      });
    } catch (error: any) {
      if (error.name !== "AbortError") {
        this.collab.excalidrawAPI.updateScene({
          appState: {
            errorMessage: error.message,
          },
        });
      }
    }

    let isChanged = false;
    const newElements = this.collab.excalidrawAPI
      .getSceneElementsIncludingDeleted()
      .map((element) => {
        if (fileManager.shouldUpdateImageElementStatus(element)) {
          isChanged = true;
          // this will signal collaborators to pull image data from server
          // (using mutation instead of newElementWith otherwise it'd break
          // in-progress dragging)
          return newElementWith(element, { status: "saved" });
        }
        return element;
      });

    if (isChanged) {
      this.collab.excalidrawAPI.updateScene({
        elements: newElements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  }, FILE_UPLOAD_TIMEOUT);

  broadcastScene = async (
    updateType: WS_SUBTYPES.INIT | WS_SUBTYPES.UPDATE,
    elements: readonly OrderedExcalidrawElement[],
    syncAll: boolean,
  ) => {
    if (updateType === WS_SUBTYPES.INIT && !syncAll) {
      throw new Error("syncAll must be true when sending SCENE.INIT");
    }

    // sync out only the elements we think we need to to save bandwidth.
    // periodically we'll resync the whole thing to make sure no one diverges
    // due to a dropped message (server goes down etc).
    const syncableElements = elements.reduce((acc, element) => {
      if (
        (syncAll ||
          !this.broadcastedElementVersions.has(element.id) ||
          element.version > this.broadcastedElementVersions.get(element.id)!) &&
        isSyncableElement(element)
      ) {
        acc.push(element);
      }
      return acc;
    }, [] as SyncableExcalidrawElement[]);

    const data: SocketUpdateDataSource[typeof updateType] = {
      type: updateType,
      payload: {
        elements: syncableElements,
      },
    };

    for (const syncableElement of syncableElements) {
      this.broadcastedElementVersions.set(
        syncableElement.id,
        syncableElement.version,
      );
    }

    this.queueFileUpload();

    await this._broadcastSocketData(data as SocketUpdateData);
  };

  broadcastIdleChange = (userState: UserIdleState) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["IDLE_STATUS"] = {
        type: WS_SUBTYPES.IDLE_STATUS,
        payload: {
          socketId: this.socket.id as SocketId,
          userState,
          username: this.collab.state.username,
        },
      };
      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastMouseLocation = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
  }) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["MOUSE_LOCATION"] = {
        type: WS_SUBTYPES.MOUSE_LOCATION,
        payload: {
          socketId: this.socket.id as SocketId,
          pointer: payload.pointer,
          button: payload.button || "up",
          selectedElementIds:
            this.collab.excalidrawAPI.getAppState().selectedElementIds,
          username: this.collab.state.username,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
      );
    }
  };

  broadcastVisibleSceneBounds = (
    payload: {
      sceneBounds: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"]["payload"]["sceneBounds"];
    },
    roomId: string,
  ) => {
    if (this.socket?.id) {
      const data: SocketUpdateDataSource["USER_VISIBLE_SCENE_BOUNDS"] = {
        type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS,
        payload: {
          socketId: this.socket.id as SocketId,
          username: this.collab.state.username,
          sceneBounds: payload.sceneBounds,
        },
      };

      return this._broadcastSocketData(
        data as SocketUpdateData,
        true, // volatile
        roomId,
      );
    }
  };

  broadcastUserFollowed = (payload: OnUserFollowedPayload) => {
    if (this.socket?.id) {
      if (this.vaultRealtimeSession) {
        const data: SocketUpdateDataSource["USER_FOLLOW_CHANGE"] = {
          type: WS_SUBTYPES.USER_FOLLOW_CHANGE,
          payload,
        };
        return this._broadcastSocketData(data as SocketUpdateData, true);
      }
      this.socket.emit(WS_EVENTS.USER_FOLLOW_CHANGE, payload);
    }
  };
}

export default Portal;
