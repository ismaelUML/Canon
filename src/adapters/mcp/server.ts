// src/adapters/mcp/server.ts
// Facade hacia @canon/presentation
export * from '../../../packages/canon_presentation/src/mcp/server.ts';
import { MCPServer } from '../../../packages/canon_presentation/src/mcp/server.ts';

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const server = new MCPServer();
  server.startStdio();
}
