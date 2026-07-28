// Webhook CamPay — URL à déclarer dans l'application CamPay.
// SÉCURITÉ : on ne fait JAMAIS confiance au payload entrant.
// Le webhook sert de déclencheur ; le statut est re-vérifié via GET /transaction/.
// IDEMPOTENT : un même webhook reçu deux fois ne produit aucun double effet.
const { admin, json } = require('./_lib/supabase');
const campay = require('./_lib/campay');

exports.handler = async (event) => {
  // CamPay notifie en GET (query params) — accepter GET et POST par prudence.
  const params =
    event.httpMethod === 'POST'
      ? (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })()
      : (event.queryStringParameters || {});

  const externalRef = params.external_reference;
  const campayRef = params.reference;
  if (!externalRef && !campayRef) return json(400, { error: 'Référence manquante' });

  // 1. Retrouver notre paiement
  let q = admin.from('payments').select('*');
  q = externalRef ? q.eq('external_reference', externalRef) : q.eq('campay_reference', campayRef);
  const { data: payment } = await q.single();
  if (!payment) return json(200, { ok: true, note: 'Paiement inconnu — ignoré' });

  // 2. Idempotence : déjà terminal → on répond 200 sans rien refaire
  if (['successful', 'failed', 'refunded'].includes(payment.status))
    return json(200, { ok: true, note: 'Déjà traité' });

  // 3. SOURCE DE VÉRITÉ : statut confirmé auprès de l'API CamPay
  let tx;
  try {
    tx = await campay.getTransaction(payment.campay_reference || campayRef);
  } catch (e) {
    console.error('Vérification transaction impossible', e.campay || e.message);
    return json(200, { ok: true, note: 'Vérification différée (polling de secours)' });
  }

  const status = String(tx.status || '').toUpperCase();
  if (status === 'PENDING') return json(200, { ok: true, note: 'Encore en attente' });

  const newStatus = status === 'SUCCESSFUL' ? 'successful' : 'failed';

  // 4. Mise à jour conditionnelle (protège contre les webhooks concurrents)
  const { data: updated } = await admin
    .from('payments')
    .update({ status: newStatus, settled_at: new Date().toISOString() })
    .eq('id', payment.id)
    .eq('status', 'pending')  // ne s'applique que si encore pending
    .select();
  if (!updated?.length) return json(200, { ok: true, note: 'Course perdue — déjà traité' });

  // 5. Effets métier
  if (newStatus === 'successful') {
    if (payment.kind === 'materials') {
      /* Avance matériel encaissée → l'artisan peut acheter et travailler */
      await admin.from('missions')
        .update({ status: 'in_progress', updated_at: new Date().toISOString() })
        .eq('id', payment.mission_id).eq('status', 'awaiting_materials');
      await admin.from('mission_events')
        .insert({ mission_id: payment.mission_id, status: 'in_progress', note: 'Avance matériel encaissée' });
    } else if (payment.kind === 'diagnostic_fee') {
      // Forfait payé → la mission part en dispatch (ramassée par run-dispatch < 1 min)
      await admin.from('missions')
        .update({ status: 'dispatching', updated_at: new Date().toISOString() })
        .eq('id', payment.mission_id).eq('status', 'pending_payment');
      await admin.from('mission_events')
        .insert({ mission_id: payment.mission_id, status: 'dispatching', note: 'Forfait encaissé' });
    } else {
      // Solde payé → mission 'paid' + création du payout artisan (envoi via campay-payout)
      const { data: mission } = await admin
        .from('missions').select('id, assigned_artisan, final_amount_fcfa, commission_fcfa')
        .eq('id', payment.mission_id).single();
      await admin.from('missions')
        .update({ status: 'paid', updated_at: new Date().toISOString() })
        .eq('id', mission.id);
      await admin.from('mission_events')
        .insert({ mission_id: mission.id, status: 'paid', note: 'Solde encaissé' });
      /* Part artisan : total facturé − commission (calculée sur la seule
         main-d'œuvre). Le matériel lui revient intégralement au coûtant. */
      const net = mission.final_amount_fcfa - mission.commission_fcfa;
      await admin.from('payouts').insert({
        mission_id: mission.id,
        artisan_id: mission.assigned_artisan,
        amount_fcfa: net,
      });
    }
  } else if (payment.kind === 'diagnostic_fee') {
    await admin.from('mission_events')
      .insert({ mission_id: payment.mission_id, status: 'pending_payment', note: 'Échec paiement forfait' });
  }

  return json(200, { ok: true, status: newStatus });
};
