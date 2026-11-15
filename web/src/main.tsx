import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initGlassMode } from "./ui/glass";
import { initSurface } from "./ui/surface";
import "./styles.css";

initSurface();
initGlassMode();

const root = document.getElementById("root");
if (!root) throw new Error("ForgePilot root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
