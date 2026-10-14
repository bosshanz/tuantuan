import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "./styles.css";

// Pause decorative avatar motion while the tab is hidden.
const syncHidden = () => document.documentElement.toggleAttribute("data-tab-hidden", document.hidden);
document.addEventListener("visibilitychange", syncHidden);
syncHidden();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
