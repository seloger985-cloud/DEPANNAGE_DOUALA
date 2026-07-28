// POST /api/mission-action — Toutes les transitions de statut pilotées par les utilisateurs.
// Body: { mission_id, action, ...params }
// Actions ARTISAN (assigned_artisan uniquement) :
//   en_route | arrived | propose_quote {amount_fcfa, details} | done | cancel_artisan
// Actions CLIENT (client_id uniquement) :
//   accept_quote {quote_id} | refuse_quote {quote_id} | confirm_done | cancel_client
// Chaque transition vérifie le statut de départ (matrice stricte) et journalise mission_events.
const { admin, getUserFromRequest, json } = require('./_lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const user = await getUserFromRequest(event);
  if (!user) return json(401, { error: 'Non authentifié' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON invalide' }); }
  const { mission_id, action } = body;
  if (!mission_id || !action) return json(400, { error: 'mission_id et action requis' });

  const { data: m } = await admin.from('missions').select('*').eq('id', mission_id).single();
  if (!m) return json(404, { error: 'Mission introuvable' });

  const isArtisan = m.assigned_artisan === user.id;
  const isClient = m.client_id === user.id;
  const now = new Date().toISOString();


  // 🟢 Libération auto : repasse l'artisan en Disponible s'il n'a plus de mission active
  const releaseArtisan = async (artisanId) => {
    if (!artisanId) return;
    const { data: active } = await admin.from('missions').select('id')
      .eq('assigned_artisan', artisanId)
      .in('status', ['assigned','en_route','arrived','quote_pending','in_progress'])
      .limit(1);
    if (!active?.length) {
      await admin.from('artisan_details')
        .update({ availability: 'available' })
        .eq('profile_id', artisanId).eq('availability', 'busy');
    }
  };

  const setStatus = async (from, to, note) => {
    const fromList = Array.isArray(from) ? from : [from];
    if (!fromList.includes(m.status))
      throw { code: 409, msg: `Transition impossible depuis '${m.status}'` };
    const { data: up } = await admin.from('missions')
      .update({ status: to, updated_at: now })
      .eq('id', m.id).in('status', fromList).select();
    if (!up?.length) throw { code: 409, msg: 'Conflit — statut modifié entre-temps' };
    await admin.from('mission_events')
      .insert({ mission_id: m.id, status: to, actor_id: user.id, note });
    return up[0];
  };

  try {
    switch (action) {
      // ================= ARTISAN =================
      case 'en_route': {
        if (!isArtisan) throw { code: 403, msg: 'Réservé à l’artisan attribué' };
        await setStatus('assigned', 'en_route', 'Artisan en route');
        break;
      }
      case 'arrived': {
        if (!isArtisan) throw { code: 403, msg: 'Réservé à l’artisan attribué' };
        /* Code d'arrivée : preuve de présence physique (patch 07).
           Le code est lu chez le client ; l'artisan n'y a aucun accès en base. */
        const { data: ac } = await admin.from('mission_arrival_codes')
          .select('code').eq('mission_id', m.id).maybeSingle();
        const given = String(body.arrival_code || '').replace(/\D/g, '');
        const skipped = body.code_unavailable === true;
        let verified = null;
        if (!skipped) {
          if (!ac?.code) throw { code: 409, msg: 'Code indisponible pour cette mission' };
          if (given !== ac.code) throw { code: 400, msg: 'Code incorrect — demande-le au client' };
          verified = true;
        } else {
          verified = false;  /* voie de secours : jamais bloquante, remontée en admin */
        }
        await admin.from('missions')
          .update({ arrived_at: now, arrival_verified: verified }).eq('id', m.id);
        await setStatus('en_route', 'arrived',
          verified ? 'Arrivée confirmée par code client' : 'Arrivée déclarée sans code (à vérifier)');
        break;
      }
      case 'propose_quote': {
        if (!isArtisan) throw { code: 403, msg: 'Réservé à l’artisan attribué' };
        const amount = parseInt(body.amount_fcfa, 10);
        const details = String(body.details || '').trim();
        if (!Number.isInteger(amount) || amount <= 0 || amount > 5000000)
          throw { code: 400, msg: 'Montant de devis invalide' };
        if (details.length < 10)
          throw { code: 400, msg: 'Décris le devis (10 caractères minimum)' };
        if (!['arrived', 'quote_pending'].includes(m.status))
          throw { code: 409, msg: 'Le devis se propose après arrivée sur place' };
        // Un seul devis actif : les précédents 'proposed' sont remplacés
        await admin.from('quotes')
          .update({ status: 'superseded', decided_at: now })
          .eq('mission_id', m.id).eq('status', 'proposed');
        await admin.from('quotes').insert({
          mission_id: m.id, artisan_id: user.id, amount_fcfa: amount, details,
        });
        if (m.status === 'arrived') await setStatus('arrived', 'quote_pending', `Devis proposé : ${amount} FCFA`);
        else await admin.from('mission_events')
          .insert({ mission_id: m.id, status: 'quote_pending', actor_id: user.id, note: `Nouveau devis : ${amount} FCFA` });
        break;
      }
      case 'done': {
        if (!isArtisan) throw { code: 403, msg: 'Réservé à l’artisan attribué' };
        await setStatus('in_progress', 'done_artisan', 'Travaux déclarés terminés');
        await releaseArtisan(m.assigned_artisan);
        break;
      }
      case 'cancel_artisan': {
        if (!isArtisan) throw { code: 403, msg: 'Réservé à l’artisan attribué' };
        await setStatus(['assigned', 'en_route', 'arrived'], 'cancelled_artisan', 'Annulée par l’artisan');
        await releaseArtisan(m.assigned_artisan);
        // Pénalité de score : le cancel_rate de la vue artisan_stats la capte automatiquement.
        break;
      }

      // ================= CLIENT =================
      case 'accept_quote': {
        if (!isClient) throw { code: 403, msg: 'Réservé au client' };
        if (m.status !== 'quote_pending') throw { code: 409, msg: 'Aucun devis en attente' };
        const { data: quote } = await admin.from('quotes')
          .select('*').eq('id', body.quote_id).eq('mission_id', m.id)
          .eq('status', 'proposed').single();
        if (!quote) throw { code: 404, msg: 'Devis introuvable ou déjà décidé' };
        // Commission calculée SERVEUR à partir du référentiel trades
        const { data: trade } = await admin.from('trades')
          .select('commission_pct, commission_min_fcfa').eq('id', m.trade_id).single();
        const commission = Math.max(
          Math.round((quote.amount_fcfa * Number(trade.commission_pct)) / 100),
          trade.commission_min_fcfa
        );
        await admin.from('quotes')
          .update({ status: 'accepted', decided_at: now }).eq('id', quote.id);
        await admin.from('missions')
          .update({ final_amount_fcfa: quote.amount_fcfa, commission_fcfa: commission, updated_at: now })
          .eq('id', m.id);
        await setStatus('quote_pending', 'in_progress', `Devis accepté : ${quote.amount_fcfa} FCFA (commission ${commission})`);
        break;
      }
      case 'refuse_quote': {
        if (!isClient) throw { code: 403, msg: 'Réservé au client' };
        if (m.status !== 'quote_pending') throw { code: 409, msg: 'Aucun devis en attente' };
        await admin.from('quotes')
          .update({ status: 'refused', decided_at: now })
          .eq('id', body.quote_id).eq('mission_id', m.id).eq('status', 'proposed');
        await setStatus('quote_pending', 'quote_refused', 'Devis refusé — forfait diagnostic acquis');
        await releaseArtisan(m.assigned_artisan);
        break;
      }
      case 'confirm_done': {
        if (!isClient) throw { code: 403, msg: 'Réservé au client' };
        await setStatus('done_artisan', 'confirmed', 'Fin de travaux confirmée par le client');
        break;
      }
      case 'cancel_client': {
        if (!isClient) throw { code: 403, msg: 'Réservé au client' };
        // Politique v1 : remboursement/retenue du forfait géré manuellement (cf. CGU art. 7)
        await setStatus(['pending_payment', 'dispatching', 'assigned'], 'cancelled_client', 'Annulée par le client');
        await releaseArtisan(m.assigned_artisan);
        break;
      }
      default:
        return json(400, { error: `Action inconnue : ${action}` });
    }
  } catch (e) {
    if (e.code) return json(e.code, { error: e.msg });
    console.error('mission-action error', e);
    return json(500, { error: 'Erreur serveur' });
  }

  const { data: fresh } = await admin.from('missions').select('*').eq('id', mission_id).single();
  return json(200, { ok: true, mission: fresh });
};
