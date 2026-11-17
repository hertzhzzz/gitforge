// The server, as main.ts expects it: createApp() builds the HTTP server and
// returns it; main.ts binds it, registers it and polls /done. The store is
// created here so all four surfaces share one instance.

import type { Server } from 'node:http';
import { Store } from './src/store.ts';
import { createHttpServer } from './src/server.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createHttpServer(store, token);
}
