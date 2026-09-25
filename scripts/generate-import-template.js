const path = require("path");
const XLSX = require("xlsx");

const workbook = XLSX.utils.book_new();

const sheets = {
  Instructions: [
    ["SubTracker Import Template"],
    ["Fill out each worksheet using the exact column headers provided."],
    ["Supported worksheets: Projects, Contractors, Project Assignments, Compliance Records, Insurance, Tiered Subs, Follow-Ups."],
    ["Yes/No columns accept Yes or No."],
    ["Date columns accept Excel dates (MM/DD/YYYY)."],
  ],
  Projects: [["Project Number", "Project Name", "Status"]],
  Contractors: [
    ["Company Name", "Trade", "Contact Name", "Email", "Phone", "Notes", "External ID", "Legacy ID", "Active"],
  ],
  "Project Assignments": [["Company Name", "Project Number", "Assigned Date", "Active"]],
  "Compliance Records": [
    [
      "Company Name",
      "Compliance Type",
      "Registration Number",
      "Effective Date",
      "Expiration Date",
      "Verified Date",
      "Verified By",
      "Verification Source",
      "Notes",
      "Active",
      "Current",
    ],
  ],
  Insurance: [
    [
      "Company Name",
      "COI On File",
      "General Liability On File",
      "General Liability Expiration Date",
      "Workers Comp On File",
      "Workers Comp Expiration Date",
    ],
  ],
  "Tiered Subs": [["Parent Company Name", "Tiered Sub Company Name", "Assigned Date", "Active"]],
  "Follow-Ups": [
    ["Company Name", "Follow-Up Date", "Method", "Status", "Related Compliance Type", "Subject", "Notes"],
  ],
  _Lists: [
    ["Project Status", "Compliance Type", "Follow-Up Method", "Follow-Up Status"],
    ["Active", "NJ PWC", "Phone", "Open"],
    ["Pending", "NJ BRC", "Email", "Waiting Response"],
    ["Completed", "NY PWC", "Meeting", "Resolved"],
    ["On Hold", "NY BRC", "Text", "Closed"],
    ["Cancelled", "W9", "Other", ""],
    ["", "Safety Certification", "", ""],
  ],
};

for (const [name, rows] of Object.entries(sheets)) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

const outputPath = path.join(__dirname, "..", "public", "SubTracker_Import_Template.xlsx");
XLSX.writeFile(workbook, outputPath);
console.log(`Template written to ${outputPath}`);
