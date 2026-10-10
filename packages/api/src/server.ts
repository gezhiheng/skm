import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { createCore, packageSchema } from '@skm/core';

const projectConfigSchema = z.object({
  inheritGlobal: z.boolean(),
  skills: z.array(z.string().min(1)),
}).strict();

const planSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('installSkill'), name: z.string().min(1), project: z.string().min(1), mode: z.enum(['symlink', 'copy']).optional() }).strict(),
  z.object({ action: z.literal('installPackage'), name: z.string().min(1), project: z.string().min(1), mode: z.enum(['symlink', 'copy']).optional() }).strict(),
  z.object({ action: z.literal('removeSkill'), name: z.string().min(1), project: z.string().min(1) }).strict(),
  z.object({ action: z.literal('initPackage'), name: z.string().min(1), project: z.string().min(1) }).strict(),
  z.object({ action: z.literal('configureProject'), project: z.string().min(1), inheritGlobal: z.boolean(), skills: z.array(z.string().min(1)) }).strict(),
  z.object({ action: z.literal('unregisterSkill'), name: z.string().min(1), deleteSource: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('updateSkill'), name: z.string().min(1), path: z.string().min(1) }).strict(),
]);

const applySchema = z.object({ confirmed: z.literal(true) }).strict();
const pathSchema = z.object({ path: z.string().min(1) }).strict();

export type ServerOptions = {
  dataDir?: string;
  webDist?: string;
  logger?: boolean;
  serveWeb?: boolean;
  allowedOrigins?: string[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCode(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  const message = messageOf(error).toLowerCase();
  if (message.includes('not found') || message.includes('not registered') || message.includes('unknown')) return 404;
  if (message.includes('conflict') || message.includes('unsafe') || message.includes('reference')) return 409;
  if (message.includes('invalid') || message.includes('must') || message.includes('required')) return 400;
  return 500;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });
  const core = createCore({ dataDir: options.dataDir });

  // Browsers must use this local origin; rejecting Host also prevents DNS rebinding.
  const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1', '::ffff:127.0.0.1'].includes(host.toLowerCase());
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  app.addHook('onRequest', async (request, reply) => {
    let localOrigin: string;
    try {
      const url = new URL(`http://${request.headers.host}`);
      if (!loopback(url.hostname) || !loopback(request.ip)) throw new Error('nonlocal');
      localOrigin = url.origin;
    } catch {
      return reply.code(403).send({ error: 'SKM accepts loopback requests with a localhost, 127.0.0.1, or [::1] Host only.' });
    }
    const origin = request.headers.origin;
    if ((origin && origin !== localOrigin && !allowedOrigins.has(origin)) || (!origin && request.headers['sec-fetch-site'] === 'cross-site')) {
      return reply.code(403).send({ error: 'Cross-origin access is denied. Open the local SKM URL, or use the documented development proxy.' });
    }
    if (request.raw.url?.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(request.method) && !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return reply.code(415).send({ error: 'API mutations require application/json.' });
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.setErrorHandler((error, _request, reply) => {
    const code = statusCode(error);
    reply.code(code).send({ error: messageOf(error) });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'skm' }));

  app.get('/api/catalog', async (request) => {
    const query = z.object({ q: z.string().optional() }).parse(request.query);
    const items = await core.registry.list(query.q);
    return { items };
  });

  app.get('/api/catalog/:name', async (request) => {
    const params = z.object({ name: z.string().min(1) }).parse(request.params);
    const query = z.object({ project: z.string().min(1).optional() }).strict().parse(request.query);
    return core.registry.inspect(params.name, query.project);
  });

  app.post('/api/skills/register', async (request, reply) => {
    const body = pathSchema.parse(request.body);
    const plan = await core.registry.registerSkill(body.path);
    return reply.code(201).send(plan);
  });

  app.post('/api/packages/register', async (request, reply) => {
    const plan = await core.registry.registerPackage(packageSchema.parse(request.body));
    return reply.code(201).send(plan);
  });

  app.get('/api/projects', async () => ({ items: await core.projects.list() }));

  app.post('/api/projects', async (request, reply) => {
    const body = pathSchema.parse(request.body);
    const plan = await core.projects.add(body.path);
    return reply.code(201).send(plan);
  });

  app.get('/api/projects/:id', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return core.projects.get(params.id);
  });

  app.get('/api/projects/:id/status', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return core.projects.status(params.id);
  });

  app.get('/api/projects/:id/effective-skills', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return core.projects.status(params.id);
  });

  app.put('/api/projects/:id/config', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const config = projectConfigSchema.parse(request.body);
    return core.projects.configure(params.id, config);
  });

  app.put('/api/global/config', async (request) => {
    const config = z.object({ skills: z.array(z.string().min(1)) }).strict().parse(request.body);
    return core.global.configure(config);
  });

  app.get('/api/global/config', async () => core.global.get());

  app.get('/api/global/status', async () => ({ skills: await core.global.status() }));

  app.get('/api/status', async () => {
    const [projects, diagnostics, catalog, globalSkills] = await Promise.all([
      core.projects.list(), core.doctor(), core.registry.list(),
      core.global.status(),
    ]);
    return { health: diagnostics.some((item) => item.severity === 'error') ? 'attention' : 'healthy', counts: { projects: projects.length, resources: catalog.length, skills: catalog.filter((item) => item.type === 'skill').length, packages: catalog.filter((item) => item.type === 'package').length, globalSkills: globalSkills.length }, diagnostics };
  });

  app.get('/api/doctor', async () => ({ diagnostics: await core.doctor() }));

  app.post('/api/plans', async (request, reply) => {
    const body = planSchema.parse(request.body);
    let plan;
    if (body.action === 'installSkill' || body.action === 'installPackage') plan = await core.packages.install(body.name, body.project, { mode: body.mode });
    else if (body.action === 'removeSkill') plan = await core.packages.remove(body.name, body.project);
    else if (body.action === 'initPackage') plan = await core.packages.init(body.name, body.project);
    else if (body.action === 'configureProject') plan = await core.projects.configure(body.project, { inheritGlobal: body.inheritGlobal, skills: body.skills });
    else if (body.action === 'unregisterSkill') plan = await core.registry.removeSkill(body.name, { deleteSource: body.deleteSource });
    else plan = await core.registry.updateSkill(body.name, body.path);
    return reply.code(201).send(plan);
  });

  app.get('/api/plans/:id', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    return core.operations.get(params.id);
  });

  app.post('/api/plans/:id/apply', async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    applySchema.parse(request.body);
    return core.operations.apply(params.id);
  });

  if (options.serveWeb !== false) {
    const defaultWebDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
    const webDist = resolve(options.webDist ?? process.env.SKM_WEB_DIST ?? defaultWebDist);
    if (existsSync(resolve(webDist, 'index.html'))) {
      await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: true });
      app.setNotFoundHandler((request, reply) => {
        if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'API route not found' });
        return reply.sendFile('index.html');
      });
    }
  }

  return app;
}
