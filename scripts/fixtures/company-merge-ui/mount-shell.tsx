import { createRoot } from "react-dom/client";
import AppShell from "../../../src/components/AppShell";

const root = document.getElementById("root");
if (!root) throw new Error("Missing synthetic AppShell root.");
createRoot(root).render(<AppShell><div data-testid="company-merge-shell-child">Company Merge administration page</div></AppShell>);
