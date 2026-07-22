// _lib/campay.js — client CamPay minimal
// Env vars Netlify :
//   CAMPAY_ENV = DEV | PROD   (DEV → demo.campay.net, plafond 100 FCFA)
//   CAMPAY_PERMANENT_TOKEN    (section APP KEYS de l'application CamPay)
//
// Règles CamPay à retenir :
//   - Montants ENTIERS uniquement (ER201), en XAF.
//   - Numéros au format 2376xxxxxxxx (ER101), MTN/Orange only (ER102).
//   - /collect/ renvoie une `reference` ; le statut final se confirme via /transaction/.

const BASE =
  process.env.CAMPAY_ENV === 'PROD'
    ? 'https://www.campay.net/api'
    : 'https://demo.campay.net/api';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Token ${process.env.CAMPAY_PERMANENT_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`CamPay ${res.status} on ${path}`);
    err.campay = data;
    throw err;
  }
  return data;
}

// Demande de paiement (push USSD chez le payeur)
function collect({ amountFcfa, fromPhone, description, externalReference }) {
  return api('/collect/', {
    method: 'POST',
    body: {
      amount: String(Math.round(amountFcfa)), // entier obligatoire
      currency: 'XAF',
      from: fromPhone,                        // 2376xxxxxxxx
      description,
      external_reference: externalReference,  // notre UUID payments.external_reference
    },
  });
}

// Reversement vers un compte Mobile Money (artisan)
function withdraw({ amountFcfa, toPhone, description, externalReference }) {
  return api('/withdraw/', {
    method: 'POST',
    body: {
      amount: String(Math.round(amountFcfa)),
      currency: 'XAF',
      to: toPhone,
      description,
      external_reference: externalReference,
    },
  });
}

// Statut d'une transaction — SOURCE DE VÉRITÉ (ne jamais se fier au seul webhook)
function getTransaction(reference) {
  return api(`/transaction/${reference}/`);
}

module.exports = { collect, withdraw, getTransaction };
