// POST /api/create-mission-payment
// Body: { mission_id, kind: 'diagnostic_fee' | 'balance', payer_phone }
// Règle d'or : le MONTANT n'est jamais accepté du client — il est recalculé ici.
const { admin, getUserFromRequest, json } = require('./_lib/supabase');
const campay = require('./_lib/campay');

// Décision produit (cf. grille-prix) : le forfait est-il déduit du solde ?
const DEDUCT_DIAGNOSTIC = process.env.DEDUCT_DIAGNOSTIC_FEE === 'true';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const user = await getUserFromRequest(event);
  if (!user) return json(401, { error: 'Non authentifié' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON invalide' }); }
  const { mission_id, kind, payer_phone } = body;

  if (!mission_id || !['diagnostic_fee', 'balance'].includes(kind))
    return json(400, { error: 'Paramètres invalides' });
  if (!/^237\d{9}$/.test(payer_phone || ''))
    return json(400, { error: 'Numéro invalide (format 2376xxxxxxxx)' });

  // 1. Mission + contrôle de propriété
  const { data: mission, error: mErr } = await admin
    .from('missions').select('*').eq('id', mission_id).single();
  if (mErr || !mission) return json(404, { error: 'Mission introuvable' });
  if (mission.client_id !== user.id) return json(403, { error: 'Interdit' });

  // 2. Montant calculé server-side selon le type
  let amountFcfa;
  if (kind === 'diagnostic_fee') {
    if (mission.status !== 'pending_payment')
      return json(409, { error: 'Forfait déjà traité pour cette mission' });
    amountFcfa = mission.diagnostic_fee_fcfa;
  } else {
    // Solde : uniquement après devis accepté et travaux terminés
    if (!['done_artisan', 'confirmed'].includes(mission.status))
      return json(409, { error: "Le solde n'est pas encore exigible" });
    const { data: quote } = await admin
      .from('quotes').select('amount_fcfa')
      .eq('mission_id', mission_id).eq('status', 'accepted')
      .order('created_at', { ascending: false }).limit(1).single();
    if (!quote) return json(409, { error: 'Aucun devis accepté' });
    amountFcfa = DEDUCT_DIAGNOSTIC
      ? Math.max(quote.amount_fcfa - mission.diagnostic_fee_fcfa, 0)
      : quote.amount_fcfa;
  }
  if (amountFcfa <= 0) return json(409, { error: 'Montant nul — rien à encaisser' });

  // 3. Idempotence : un seul paiement pending/successful par (mission, kind)
  const { data: existing } = await admin
    .from('payments').select('id,status,external_reference')
    .eq('mission_id', mission_id).eq('kind', kind)
    .in('status', ['pending', 'successful']);
  if (existing?.length)
    return json(409, { error: 'Paiement déjà initié', payment: existing[0] });

  // 4. Ligne payments (external_reference généré par la base)
  const { data: payment, error: pErr } = await admin
    .from('payments')
    .insert({ mission_id, kind, amount_fcfa: amountFcfa, payer_phone })
    .select().single();
  if (pErr) return json(500, { error: 'Erreur création paiement' });

  // 5. Appel CamPay
  try {
    const res = await campay.collect({
      amountFcfa,
      fromPhone: payer_phone,
      description: `Mission ${mission_id.slice(0, 8)} — ${kind === 'diagnostic_fee' ? 'forfait diagnostic' : 'solde prestation'}`,
      externalReference: payment.external_reference,
    });
    await admin.from('payments')
      .update({ campay_reference: res.reference })
      .eq('id', payment.id);
    return json(200, {
      payment_id: payment.id,
      amount_fcfa: amountFcfa,
      campay_reference: res.reference,
      ussd_code: res.ussd_code || null, // si fourni : afficher au client en secours du push
    });
  } catch (e) {
    await admin.from('payments').update({ status: 'failed' }).eq('id', payment.id);
    console.error('CamPay collect error', e.campay || e.message);
    return json(502, { error: 'Échec initiation paiement', detail: e.campay?.message });
  }
};
