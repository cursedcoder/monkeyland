import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

declare global {
  interface Window {
    __TAURI_VALIDATE__?: boolean;
  }
}

async function bootstrap() {
  if (typeof window !== "undefined" && window.__TAURI_VALIDATE__) {
    const { mockIPC, mockWindows } = await import("@tauri-apps/api/mocks");
    mockWindows("main");
    mockIPC((cmd, _payload) => {
      switch (cmd) {
        case "load_canvas_layout":
          return { layouts: [] };
        case "save_canvas_layout":
          return undefined;
        case "load_llm_settings":
          return { provider: "anthropic", model: "claude-sonnet-4-20250514" };
        case "save_llm_settings":
          return undefined;
        case "get_llm_api_key":
          return null;
        case "set_llm_api_key":
          return undefined;
        case "get_llm_setup_done":
          return true;
        case "set_llm_setup_done":
          return undefined;
        case "terminal_spawn":
          return undefined;
        case "terminal_write":
          return undefined;
        case "terminal_resize":
          return undefined;
        default:
          return undefined;
      }
    });
  }

  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

bootstrap();
