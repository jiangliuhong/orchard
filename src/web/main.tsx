import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import "./styles.css";
import "./agent-chat/agent-chat.css";
createRoot(document.getElementById("root")!).render(<ThemeProvider><App /></ThemeProvider>);
