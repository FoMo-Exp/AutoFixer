/// <reference types="vite/client" />

interface Window {
  forgePilotConfig?: {
    apiBaseUrl: string;
  };
  forgePilotApi?: {
    request: (request: {
      requestId: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body?: string;
      stream: boolean;
    }>;
    abort: (requestId: string) => void;
    onStream: (
      requestId: string,
      callback: (message: {
        type: "chunk" | "end" | "error";
        text?: string;
        message?: string;
      }) => void,
    ) => () => void;
  };
}
