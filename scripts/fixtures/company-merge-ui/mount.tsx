import { createRoot } from "react-dom/client";
import CompanyMergeAdministrationPage from "../../../src/app/admin/company-merge/page";

const root = document.getElementById("root");
if (!root) throw new Error("Missing synthetic UI root.");
createRoot(root).render(<CompanyMergeAdministrationPage />);
