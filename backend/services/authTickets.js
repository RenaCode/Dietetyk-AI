const crypto = require('crypto');

// One-time, 60-second tickets that start an OAuth connect/link flow.
//
// Those flows begin with a top-level navigation (window.location = /api/auth/<service>), which
// cannot carry an Authorization header, so the frontend used to put the SESSION TOKEN in the
// query string: /api/auth/oura?token=sess_... Morgan redacted it, but nginx in front of the
// backend logs the full request line, so every connect click wrote a 7-30 day session token
// into the frontend pod's access log - a login for anyone with `kubectl logs` or access to
// wherever those logs are shipped. It also stayed in browser history.
//
// A ticket is minted by an authenticated fetch (POST /api/auth/ticket, routes/account.js),
// names the one flow it is good for, dies after 60 seconds and works once. If it does leak
// through a log, it is already spent.
//
// In process memory: the backend is a single replica (see charts/dietetyk), and a ticket lost
// to a restart costs the user one more click.
const TICKET_TTL_MS = 60 * 1000;
const tickets = new Map(); // ticket -> { userId, service, expiresAt }

function issueTicket(userId, service) {
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
  const ticket = 'tkt_' + crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { userId, service, expiresAt: now + TICKET_TTL_MS });
  return ticket;
}

// Returns the userId the ticket was issued to, or null. The ticket is deleted on the first
// lookup whether or not it matches the requested service.
function consumeTicket(ticket, service) {
  if (typeof ticket !== 'string') return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now() || entry.service !== service) return null;
  return entry.userId;
}

module.exports = { issueTicket, consumeTicket, TICKET_TTL_MS };
