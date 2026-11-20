// Lance la suite de tests contre un PostgreSQL :
// - TEST_DATABASE_URL s'il est défini (CI) ;
// - sinon un PostgreSQL embarqué et jetable (aucune installation requise).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    }).on('error', reject);
  });
}

let databaseUrl = process.env.TEST_DATABASE_URL;
let embedded = null;
let dataDir = null;

if (!databaseUrl) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort();
  dataDir = await mkdtemp(join(tmpdir(), 'vdv-test-pg-'));
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'vdv', password: 'vdv', port, persistent: false, onLog: () => {},
  });
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase('vdv_test');
  databaseUrl = `postgres://vdv:vdv@localhost:${port}/vdv_test`;
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  BASE_URL: 'http://vote.test',
  SMTP_DEV_MODE: 'true',
  // Secrets de test, régénérés à chaque exécution.
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  EMAIL_HASH_SECRET: crypto.randomBytes(32).toString('hex'),
};

let code = await run(process.execPath, ['src/migrate.js'], env);
if (code === 0) {
  code = await run(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), 'test/*.test.js'], env);
}

if (embedded) {
  await embedded.stop();
  await rm(dataDir, { recursive: true, force: true });
}
process.exitCode = code;
