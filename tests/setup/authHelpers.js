// Shared helpers for integration tests: register + log in a real user (or
// admin) through the actual HTTP routes, using a supertest agent so the
// session cookie carries over to subsequent requests.
import request from 'supertest';

let counter = 0;

export function uniqueUser(overrides = {}) {
  counter += 1;
  return {
    name: 'Test Student',
    username: `student${Date.now()}${counter}`,
    email: `student${Date.now()}${counter}@example.com`,
    password: 'Passw0rd',
    terms: 'on',
    ...overrides,
  };
}

/**
 * Registers a new user and logs them in on a fresh supertest agent.
 * Returns { agent, user } - `agent` carries the session cookie for
 * subsequent authenticated requests.
 */
export async function registerAndLogin(app, overrides = {}) {
  const user = uniqueUser(overrides);
  const agent = request.agent(app);

  const registerRes = await agent.post('/create-account').type('form').send(user);
  if (registerRes.status >= 400) {
    throw new Error(`registerAndLogin: registration failed (${registerRes.status}): ${registerRes.text}`);
  }

  const loginRes = await agent.post('/').type('form').send({ username: user.username, password: user.password });
  if (loginRes.status >= 400 || !loginRes.headers.location || loginRes.headers.location.includes('error')) {
    throw new Error(`registerAndLogin: login failed (${loginRes.status}), location=${loginRes.headers.location}`);
  }

  return { agent, user };
}
