import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./planning.css";
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
