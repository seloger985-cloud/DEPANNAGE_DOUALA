// run-dispatch — fonction PLANIFIÉE (toutes les minutes).
// netlify.toml :
//   [functions."run-dispatch"]
//   schedule = "* * * * *"
//
// Rôles :
//   1. Expirer les dispatches pending dépassés.
//   2. Envoyer la vague suivante pour les missions en 'dispatching'
//      (vague 1 : top 3 artisans classés ; vague 2 : 5 suivants ; ensuite : dispatch_failed + alerte admin).
//   3. Housekeeping : auto-confirmation à 24 h, polling des paiements pending sans webhook.
const { admin } = require('./_lib/supabase');
const campay = require('./_lib/campay');

const WINDOW_MIN = 10;           // fenêtre de réponse artisan
const WAVE_SIZES = [3, 5];       // vague 1, vague 2
const CONFIRM_TIMEOUT_H = 24;    // auto-confirmation client
const PAYMENT_POLL_MIN = 5;      // polling paiements sans webhook après N minutes

exports.handler = async () => {
  const now = new Date();

  // ---------- 1. Expirer les dispatches dépassés ----------
  await admin.from('mission_dispatches')
    .update({ response: 'expired' })
    .eq('response', 'pending')
    .lt('expires_at', now.toISOString());

  // ---------- 2. Vagues de dispatch ----------
  const { data: missions } = await admin
    .from('missions')
    .select('id, trade_id, zone_id, urgency, created_at')
    .eq('status', 'dispatching');

  for (const mission of missions || []) {
    const { data: dispatches } = await admin
      .from('mission_dispatches')
      .select('artisan_id, wave, response')
      .eq('mission_id', mission.id);

    const hasPending = dispatches?.some((d) => d.response === 'pending');
    if (hasPending) continue; // fenêtre en cours — on attend

    const lastWave = Math.max(0, ...(dispatches || []).map((d) => d.wave));
    if (lastWave >= WAVE_SIZES.length) {
      // Toutes les vagues épuisées sans acceptation → alerte admin
      await admin.from('missions')
        .update({ status: 'dispatch_failed', updated_at: now.toISOString() })
        .eq('id', mission.id).eq('status', 'dispatching');
      await admin.from('mission_events')
        .insert({ mission_id: mission.id, status: 'dispatch_failed', note: 'Aucune réponse après 2 vagues' });
      await notifyAdmin(`⚠️ Dispatch échoué — mission ${mission.id} (${mission.trade_id}, ${mission.zone_id}). Intervention manuelle requise.`);
      continue;
    }

    // Candidats : KYC ok, dispo, non suspendus, métier + zone, pas déjà notifiés
    const alreadyNotified = (dispatches || []).map((d) => d.artisan_id);
    const candidates = await rankCandidates(mission, alreadyNotified);
    const wave = lastWave + 1;
    const batch = candidates.slice(0, WAVE_SIZES[wave - 1]);
    if (!batch.length) {
      // Personne à notifier → équivalent d'un échec de vague
      await admin.from('missions')
        .update({ status: 'dispatch_failed', updated_at: now.toISOString() })
        .eq('id', mission.id).eq('status', 'dispatching');
      await notifyAdmin(`⚠️ Aucun artisan éligible — mission ${mission.id} (${mission.trade_id}, ${mission.zone_id}).`);
      continue;
    }

    const expiresAt = new Date(now.getTime() + WINDOW_MIN * 60000).toISOString();
    await admin.from('mission_dispatches').insert(
      batch.map((c) => ({
        mission_id: mission.id,
        artisan_id: c.profile_id,
        wave,
        expires_at: expiresAt,
      }))
    );
    // Notification artisans : Realtime pousse la ligne (abonnement PWA) + SMS de secours
    for (const c of batch) await notifyArtisan(c, mission);
  }

  // ---------- 3a. Auto-confirmation à 24 h ----------
  const cutoff = new Date(now.getTime() - CONFIRM_TIMEOUT_H * 3600000).toISOString();
  const { data: staleDone } = await admin
    .from('missions').select('id, updated_at')
    .eq('status', 'done_artisan').lt('updated_at', cutoff);
  for (const m of staleDone || []) {
    await admin.from('missions')
      .update({ status: 'confirmed', updated_at: now.toISOString() })
      .eq('id', m.id).eq('status', 'done_artisan');
    await admin.from('mission_events')
      .insert({ mission_id: m.id, status: 'confirmed', note: 'Auto-confirmation 24h sans réaction client' });
  }

  // ---------- 3b. Polling de secours des paiements pending ----------
  const pollCutoff = new Date(now.getTime() - PAYMENT_POLL_MIN * 60000).toISOString();
  const { data: stalePayments } = await admin
    .from('payments').select('id, campay_reference, external_reference')
    .eq('status', 'pending').not('campay_reference', 'is', null)
    .lt('created_at', pollCutoff);
  for (const p of stalePayments || []) {
    try {
      const tx = await campay.getTransaction(p.campay_reference);
      const s = String(tx.status || '').toUpperCase();
      if (s === 'SUCCESSFUL' || s === 'FAILED') {
        // Rejoue le circuit webhook (idempotent) pour appliquer les effets métier
        await fetch(`${process.env.URL}/.netlify/functions/campay-webhook?external_reference=${p.external_reference}&reference=${p.campay_reference}`);
      }
    } catch (e) {
      console.error('Polling paiement échoué', p.id, e.message);
    }
  }

  return { statusCode: 200, body: 'ok' };
};

// ---------- Classement des candidats (les 4 indicateurs v1) ----------
async function rankCandidates(mission, excludeIds) {
  // Éligibles : approved + dispo + métier + zone
  const { data: eligible } = await admin
    .from('artisan_details')
    .select(`
      profile_id, is_available, suspended_until,
      artisan_trades!inner(trade_id),
      artisan_zones!inner(zone_id)
    `)
    .eq('kyc_status', 'approved')
    .eq('is_available', true)
    .eq('artisan_trades.trade_id', mission.trade_id)
    .eq('artisan_zones.zone_id', mission.zone_id);

  const now = Date.now();
  const pool = (eligible || []).filter(
    (a) =>
      !excludeIds.includes(a.profile_id) &&
      (!a.suspended_until || new Date(a.suspended_until).getTime() < now)
  );
  if (!pool.length) return [];

  // Stats (vue artisan_stats) pour le scoring
  const ids = pool.map((a) => a.profile_id);
  const { data: stats } = await admin
    .from('artisan_stats').select('*').in('profile_id', ids);
  const byId = Object.fromEntries((stats || []).map((s) => [s.profile_id, s]));

  // Score v1 : note (40 %) + taux d'acceptation (35 %) + expérience (15 %) − annulations (10 %)
  // La distance fine viendra en phase 2 (ici zone = quartier, déjà filtrée).
  return pool
    .map((a) => {
      const s = byId[a.profile_id] || {};
      const rating = Number(s.avg_rating ?? 3) / 5;               // 0–1
      const accept = Number(s.acceptance_rate ?? 0.5);            // 0–1
      const exp = Math.min(Number(s.completed ?? 0) / 20, 1);     // plafonné à 20 missions
      const cancel = Number(s.cancel_rate ?? 0);                  // 0–1
      return { ...a, score: 0.4 * rating + 0.35 * accept + 0.15 * exp - 0.1 * cancel };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------- Notifications (à brancher) ----------
async function notifyArtisan(candidate, mission) {
  // v1 : la PWA artisan est abonnée en Realtime à mission_dispatches (insert = notification).
  // Secours SMS : brancher ici le fournisseur SMS retenu (coût à surveiller).
  // TODO SMS: `Nouvelle mission ${mission.trade_id} à ${mission.zone_id}. Ouvre l'app — 10 min pour accepter.`
  console.log('notify artisan', candidate.profile_id, 'mission', mission.id);
}

async function notifyAdmin(message) {
  // v1 : toi. Options simples : email Netlify, ou webhook WhatsApp Business si dispo.
  console.error('[ADMIN ALERT]', message);
}
