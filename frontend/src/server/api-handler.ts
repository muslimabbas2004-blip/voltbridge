import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { credentialsSchema, blankHome, homeSchema, patchSchema, eventSchema } from '../../backend/contracts.mjs';
import { makePlan, simulateEvent } from '../../backend/planning.mjs';
import { geminiAnswer } from '../../backend/gemini.mjs';
import { hardwareRequest } from '../../backend/hardware.mjs';

const derive = promisify(scrypt);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const lifetime = 7 * 24 * 3600;

const passwordHash = async (password: string, salt: string) =>
  (await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  const dbPath = process.env['VOLT_DB_PATH'] || (process.env['VERCEL'] ? '/tmp/voltbridge.sqlite' : resolve('data/voltbridge.sqlite'));
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS homes (user_id TEXT PRIMARY KEY REFERENCES users(id), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, snapshot TEXT NOT NULL, result TEXT NOT NULL);
    PRAGMA user_version=1;`);
  dbInstance = db;
  return db;
}

function session(cookieHeader: string | null): { id: string; token: string } | null {
  const token = /(?:^|;\s*)vb_session=([a-f0-9]{64})(?:;|$)/.exec(cookieHeader ?? '')?.[1];
  if (!token) return null;
  const db = getDb();
  const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), Date.now()) as { user_id: string } | undefined;
  return row ? { id: row.user_id, token } : null;
}

function envelope(userId: string) {
  const db = getDb();
  const home = db.prepare('SELECT data, revision FROM homes WHERE user_id=?').get(userId) as { data: string; revision: number } | undefined;
  const user = db.prepare('SELECT id, email FROM users WHERE id=?').get(userId) as { id: string; email: string } | undefined;
  if (!home || !user) throw new Error('Home not found');
  return { user, state: JSON.parse(home.data), revision: home.revision };
}

function makeCookie(token: string, maxAge = lifetime, secure = true): string {
  return `vb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

export async function handleApiRequest(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) return null;

  const method = request.method;
  const isSecure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const cookieHeader = request.headers.get('cookie');

  try {
    // 1. Health check
    if (path === '/api/health' && method === 'GET') {
      return json({
        ok: true,
        storage: 'sqlite',
        liveInverter: false,
        assistant: process.env['GEMINI_API_KEY'] ? 'gemini-configured' : 'rules',
      });
    }

    // 2. Hardware proxy
    if (['/api/hardware/status', '/api/hardware/control'].includes(path) && method === 'POST') {
      const input = (await request.json().catch(() => ({}))) as { connection?: unknown; control?: unknown };
      return json(await hardwareRequest(input.connection, path.endsWith('/control') ? input.control ?? {} : undefined));
    }

    // 3. Auth Session check
    const current = session(cookieHeader);
    if (path === '/api/auth/session' && method === 'GET') {
      return json(current ? envelope(current.id) : { user: null });
    }

    // 4. Register or Login
    if (['/api/auth/register', '/api/auth/login'].includes(path) && method === 'POST') {
      const raw = await request.json().catch(() => { throw new Error('Invalid JSON.'); });
      const input = credentialsSchema.parse(raw);
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(input.email) as { id: string; email: string; salt: string; password_hash: string } | undefined;

      if (path.endsWith('/register')) {
        if (user) return json({ error: 'An account with this email already exists.' }, 409);
        const id = randomUUID();
        const salt = randomBytes(16).toString('hex');
        const passHash = await passwordHash(input.password, salt);
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, input.email, salt, passHash);
          db.prepare('INSERT INTO homes VALUES(?,?,0)').run(id, JSON.stringify(blankHome(input.name || 'My home')));
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          return json({ error: 'An account with this email already exists.' }, 409);
        }

        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), id, Date.now() + lifetime * 1000);
        return json(envelope(id), 201, { 'Set-Cookie': makeCookie(token, lifetime, isSecure) });
      }

      // Login
      const computed = await passwordHash(input.password, user?.salt ?? '00000000000000000000000000000000');
      if (!user || !timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
        return json({ error: 'Email or password is incorrect.' }, 401);
      }
      const token = randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), user.id, Date.now() + lifetime * 1000);
      return json(envelope(user.id), 200, { 'Set-Cookie': makeCookie(token, lifetime, isSecure) });
    }

    // Require Auth beyond this point
    if (!current) {
      return json({ error: 'Please sign in to access your saved home.' }, 401);
    }

    // 5. Logout
    if (path === '/api/auth/logout' && method === 'POST') {
      const db = getDb();
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(current.token));
      return json({ ok: true }, 200, { 'Set-Cookie': makeCookie('', 0, isSecure) });
    }

    // 6. Home data (GET & PATCH)
    if (path === '/api/home' && method === 'GET') {
      return json(envelope(current.id));
    }

    if (path === '/api/home' && method === 'PATCH') {
      const raw = await request.json().catch(() => { throw new Error('Invalid JSON.'); });
      const { revision, changes } = patchSchema.parse(raw);
      const old = envelope(current.id);
      if (old.revision !== revision) {
        return json({ error: 'Your home changed in another tab. Reload before saving.' }, 409);
      }
      const next = homeSchema.parse({ ...old.state, ...changes });
      const db = getDb();
      const result = db.prepare('UPDATE homes SET data=?, revision=revision+1 WHERE user_id=? AND revision=?').run(JSON.stringify(next), current.id, revision);
      if (!result.changes) {
        return json({ error: 'Your home changed. Reload before saving.' }, 409);
      }
      return json(envelope(current.id));
    }

    // 7. Plan generation
    const home = envelope(current.id);
    if (path === '/api/plan' && method === 'GET') {
      const plan = makePlan(home.state, home.revision);
      const db = getDb();
      db.prepare('INSERT INTO plans VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,result=excluded.result')
        .run(current.id, home.revision, JSON.stringify(home.state), JSON.stringify(plan));
      return json(plan);
    }

    // 8. Event simulation
    if (path === '/api/events/simulate' && method === 'POST') {
      const raw = await request.json().catch(() => { throw new Error('Invalid JSON.'); });
      return json(simulateEvent(home.state, eventSchema.parse(raw)));
    }

    // 9. AI Assistant
    if (path === '/api/assistant' && method === 'POST') {
      const raw = (await request.json().catch(() => ({}))) as { question?: string };
      const { question } = z.object({ question: z.string().trim().min(1).max(2000) }).strict().parse(raw);
      return json(await geminiAnswer(home.state, question, home.revision));
    }

    return json({ error: 'Endpoint not found.' }, 404);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return json({
        error: 'Check the entered values.',
        issues: error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      }, 422);
    }
    const message = error instanceof Error ? error.message : 'Unable to complete the request.';
    return json({ error: message }, 500);
  }
}
