import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initSurface } from "./ui/surface";
import "./styles.css";

initSurface();

const root = document.getElementById("root");
if (!root) throw new Error("ForgePilot root element is missing.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
