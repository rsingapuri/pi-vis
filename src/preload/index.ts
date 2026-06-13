import type { IpcEventContract, IpcInvokeContract } from "@shared/ipc-contract.js";
import { contextBridge, ipcRenderer } from "electron";

type IpcEventCallback<T> = (payload: T) => void;

const pivis = {
  invoke: <K extends keyof IpcInvokeContract>(
    channel: K,
    args: IpcInvokeContract[K]["req"],
  ): Promise<IpcInvokeContract[K]["res"]> => {
    return ipcRenderer.invoke(channel, args) as Promise<IpcInvokeContract[K]["res"]>;
  },

  on: <K extends keyof IpcEventContract>(
    channel: K,
    callback: IpcEventCallback<IpcEventContract[K]>,
  ): (() => void) => {
    const handler = (_evt: Electron.IpcRendererEvent, payload: IpcEventContract[K]) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld("pivis", pivis);

export type PivisAPI = typeof pivis;
