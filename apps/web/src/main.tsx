import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "@fontsource/sora/latin-500.css";
import "@fontsource/sora/latin-600.css";
import "@fontsource/sora/latin-700.css";
import "@fontsource/sora/latin-800.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/fraunces/latin-500-italic.css";
import "@fontsource/fraunces/latin-600-italic.css";
import "./ui/ui.css";
import "./styles.css";
import "./planning.css";
import "./sorteio.css";
import "./registration.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // The registration's default scope is the deployed app path, including Pages subpaths.
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => {
      // Local persistence remains available; installation status is displayed in settings.
    });
}
