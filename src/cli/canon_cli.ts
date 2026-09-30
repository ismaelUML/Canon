// src/cli/canon_cli.ts
// Facade hacia @canon/presentation
export * from '../../packages/canon_presentation/src/cli/canon_cli.ts';
import { runCli } from '../../packages/canon_presentation/src/cli/canon_cli.ts';

if (process.argv[1] && process.argv[1].endsWith('canon_cli.ts')) {
  runCli(process.argv).catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
}
