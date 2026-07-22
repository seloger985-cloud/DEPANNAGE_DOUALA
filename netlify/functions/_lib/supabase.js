// _lib/supabase.js — clients Supabase partagés
// SERVICE_ROLE : réservé aux fonctions serveur. Jamais exposé au front.
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;

// Client service role : bypass RLS — toutes les écritures financières passent par lui.
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Résout l'utilisateur à partir du header Authorization: Bearer <jwt>
async function getUserFromRequest(event) {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

module.exports = { admin, getUserFromRequest, json };
