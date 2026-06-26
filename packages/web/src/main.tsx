import { createRoot } from "react-dom/client";
import { App } from "./components/App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("no #root element");

createRoot(rootEl).render(<App />);
