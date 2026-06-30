const created = new Date(2026, 0, 1);

const folders = [
  "/NAS",
  "/NAS/00 Project Archive",
  "/NAS/00 Project Archive/2026",
  "/NAS/00 Project Archive/2026/[Event Name]",
  "/NAS/00 Project Archive/2026/[Event Name]/00 Documents",
  "/NAS/00 Project Archive/2026/[Event Name]/00 Documents/AVP Scripts",
  "/NAS/00 Project Archive/2026/[Event Name]/00 Documents/Program Scripts",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Final Hi-Res AVP Files",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Relevant Music VO and Voice Over [Truncated]",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Selected Raw Shoot Footage",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Shared Assets",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Shared Assets/Logos",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Shared Assets/Music Library",
  "/NAS/00 Project Archive/2026/[Event Name]/01 AVP and Shooting/Shared Assets/Voice Overs",
  "/NAS/00 Project Archive/2026/[Event Name]/02 Photo Coverage",
  "/NAS/00 Project Archive/2026/[Event Name]/02 Photo Coverage/[Client Name] - [Event Name]",
  "/NAS/00 Project Archive/2026/[Event Name]/03 Video Photo Coverage and ...",
  "/NAS/00 Project Archive/2026/[Event Name]/03 Video Photo Coverage and .../Final SDE and Highlights",
  "/NAS/00 Project Archive/2026/[Event Name]/03 Video Photo Coverage and .../Raw Coverage",
  "/NAS/00 Project Archive/2026/[Event Name]/04 Presentations",
  "/NAS/00 Project Archive/2026/[Event Name]/04 Presentations/Approved Pitch Deck (PDF)",
  "/NAS/00 Project Archive/2026/[Event Name]/04 Presentations/Event Decks (Full Resolution)",
  "/NAS/01 Reference Files",
  "/NAS/01 Reference Files/Profile Deck",
  "/NAS/01 Reference Files/Templates",
  "/NAS/02 Company Documents",
  "/NAS/02 Company Documents/Handbook and Policies",
  "/NAS/02 Company Documents/HR Forms",
  "/NAS/02 Company Documents/Org Chart",
  "/NAS/02 Company Documents/Process Flow",
];

export function getData() {
  return folders.map((id) => ({
    id,
    type: "folder",
    date: created,
  }));
}
