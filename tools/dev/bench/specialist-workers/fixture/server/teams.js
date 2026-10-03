// Teams in the workspace (read-only demo data).

const TEAMS = [
  { id: 1, name: 'Platform', members: 6 },
  { id: 2, name: 'Design', members: 3 },
  { id: 3, name: 'Support', members: 4 },
];

export function listTeams() {
  return TEAMS.map((t) => ({ ...t }));
}
