#!/usr/bin/env node
import { runServer } from './run-server.js';
import { runWrapper } from './wrapper-cli.js';

const [subcommand, ...rest] = process.argv.slice(2);

switch (subcommand) {
  case 'run':
    await runWrapper(rest);
    break;
  case 'serve':
  case undefined:
    await runServer();
    break;
  case 'help':
  case '-h':
  case '--help':
    printHelp();
    break;
  default:
    process.stderr.write(`switchboard: unknown subcommand '${subcommand}'\n\n`);
    printHelp();
    process.exit(1);
}

function printHelp(): void {
  process.stdout.write(`switchboard — multi-agent CLI control over the web

Usage:
  switchboard [serve]                          Start the HTTP+WS server (default)
  switchboard run [options] <cmd> [args...]    Wrap a process and expose it via the server
  switchboard help                             Show this help

For options to 'run', see: switchboard run --help

Environment:
  PORT          Server port (default: 8787)
  HOST          Server bind interface (default: 0.0.0.0)
  LOG_LEVEL     Fastify log level (default: info)
`);
}
