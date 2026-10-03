import http from 'node:http';
import { route } from './routes.js';

/** The API server, not yet listening (tests call .listen(0)). */
export function createApi() {
  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message) }));
    });
  });
}
