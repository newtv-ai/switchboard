# @switchboard/sdk

Adapter contract for [Switchboard](../../README.md). Import this package to write a third-party agent adapter.

## Quick start

```ts
import type { AgentAdapter } from '@switchboard/sdk';

const adapter: AgentAdapter = {
  manifest: {
    id: 'my-agent',
    displayName: 'My Agent',
    adapterVersion: '0.1.0',
    agentVersionRange: '^1.0.0',
    capabilities: [],
  },
  buildCommand: ({ cwd, env }) => ({
    command: 'my-agent',
    args: ['--interactive'],
    env: env ?? {},
    cwd,
  }),
};

export default adapter;
```
