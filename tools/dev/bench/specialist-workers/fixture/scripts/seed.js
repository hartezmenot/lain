// Reset data/workspace.json to the demo defaults.
import fs from 'node:fs';

fs.writeFileSync(new URL('../data/workspace.json', import.meta.url), JSON.stringify({ workspaceName: 'Analytical Engines', digest: 'weekly' }, null, 2));
console.log('seeded');
