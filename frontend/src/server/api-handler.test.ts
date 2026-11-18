import { describe, expect, it } from 'vitest';
import { handleApiRequest } from './api-handler';

describe('Server API Handler for Vercel/SSR', () => {
  it('returns health status on GET /api/health', async () => {
    const request = new Request('http://localhost:5173/api/health', { method: 'GET' });
    const response = await handleApiRequest(request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const data = await response?.json();
    expect(data.ok).toBe(true);
    expect(data.storage).toBe('sqlite');
  });

  it('returns user: null on unauthenticated GET /api/auth/session', async () => {
    const request = new Request('http://localhost:5173/api/auth/session', { method: 'GET' });
    const response = await handleApiRequest(request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const data = await response?.json();
    expect(data.user).toBeNull();
  });

  it('registers a new user and sets a session cookie on POST /api/auth/register', async () => {
    const email = `test-${Date.now()}@example.com`;
    const request = new Request('http://localhost:5173/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'password12345678', name: 'Vercel Test Home' }),
    });
    const response = await handleApiRequest(request);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(201);
    expect(response?.headers.get('Set-Cookie')).toContain('vb_session=');
    const data = await response?.json();
    expect(data.user.email).toBe(email);
    expect(data.state.userName).toBe('Vercel Test Home');
  });
});
