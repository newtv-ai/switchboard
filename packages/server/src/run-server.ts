import { startServer } from './server.js';

/**
 * `switchboard` (with no args) or `switchboard serve` starts the HTTP+WS server.
 */
export async function runServer(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  // Default 0.0.0.0 so phones on the same Tailscale/LAN can reach /ws.
  // The /wrap endpoint is still localhost-only (enforced in server.ts).
  // Phase 4 will replace this with auth + tailscale-interface-only binding.
  const host = process.env.HOST ?? '0.0.0.0';

  const server = await startServer({ host, port });

  console.log(`\n  Switchboard server listening on ${server.url}`);
  console.log(`  Browser WS:  ws://${host}:${port}/ws`);
  console.log(`  Wrapper WS:  ws://127.0.0.1:${port}/wrap (localhost-only)`);
  console.log(`  Health:      ${server.url}/health`);
  console.log('');

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\nReceived ${sig}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
