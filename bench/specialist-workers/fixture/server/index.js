import { createApi } from './app.js';
import { log } from './log.js';

const port = Number(process.env.API_PORT || 8787);
createApi().listen(port, '127.0.0.1', () => log.info(`TeamDesk API on http://127.0.0.1:${port}`));
