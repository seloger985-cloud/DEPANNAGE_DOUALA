// POST /api/campay-payout — Reversement artisan (bouton "Reverser" de l'admin en v1)
// Body: { payout_id }
// Admin only. Vérifie le MoMo artisan, appelle /withdraw/, trace le résultat.
const { admin, getUserFromRequest, json } = require('./_lib/supabase');
const campay = require('./_lib/campay');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const user = await getUserFromRequest(event);
  if (!user) return json(401, { error: 'Non authentifié' });
  const { data: profile } = await admin
    .from('profiles').select('role').eq('id', user.id).single();
  if (profile?.role !== 'admin') return json(403, { error: 'Admin uniquement' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON invalide' }); }
  const { payout_id } = body;
  if (!payout_id) return json(400, { error: 'payout_id requis' });

  // 1. Payout pending uniquement (idempotence)
  const { data: payout } = await admin
    .from('payouts').select('*').eq('id', payout_id).single();
  if (!payout) return json(404, { error: 'Payout introuvable' });
  if (payout.status !== 'pending')
    return json(409, { error: `Payout déjà ${payout.status}` });

  // 2. Numéro MoMo de l'artisan (vérifié au KYC via Holder Info)
  const { data: artisan } = await admin
    .from('artisan_details').select('momo_number, momo_verified')
    .eq('profile_id', payout.artisan_id).single();
  if (!artisan?.momo_number || !/^237\d{9}$/.test(artisan.momo_number))
    return json(409, { error: 'Numéro MoMo artisan manquant ou invalide' });
  if (!artisan.momo_verified)
    return json(409, { error: 'Numéro MoMo non vérifié — bloquer le reversement' });

  // 3. Withdraw CamPay
  try {
    const res = await campay.withdraw({
      amountFcfa: payout.amount_fcfa,
      toPhone: artisan.momo_number,
      description: `Reversement mission ${payout.mission_id.slice(0, 8)}`,
      externalReference: payout.id,
    });
    await admin.from('payouts')
      .update({ status: 'sent', campay_reference: res.reference, sent_at: new Date().toISOString() })
      .eq('id', payout.id).eq('status', 'pending');
    await admin.from('mission_events')
      .insert({ mission_id: payout.mission_id, status: 'closed', actor_id: user.id, note: `Payout ${payout.amount_fcfa} FCFA envoyé` });
    await admin.from('missions')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', payout.mission_id).eq('status', 'paid');
    return json(200, { ok: true, campay_reference: res.reference });
  } catch (e) {
    console.error('CamPay withdraw error', e.campay || e.message);
    await admin.from('payouts')
      .update({ status: 'failed' }).eq('id', payout.id).eq('status', 'pending');
    // ER301 = solde CamPay insuffisant → alimenter le compte avant de relancer
    return json(502, { error: 'Échec reversement', detail: e.campay?.message || e.campay?.error_code });
  }
};
