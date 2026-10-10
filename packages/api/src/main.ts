import { buildServer } from './server.js';

const host = process.env.SKM_HOST ?? '127.0.0.1';
const port = Number(process.env.SKM_PORT ?? 4318);
const app = await buildServer({
  allowedOrigins: process.env.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : [],
});

try {
  await app.listen({ host, port });
  process.stdout.write(`SKM is available at http://${host}:${port}\n`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
