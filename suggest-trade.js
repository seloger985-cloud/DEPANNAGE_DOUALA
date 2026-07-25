// POST /api/suggest-trade — Body: { description }
// Reformule le problème du client et identifie le(s) métier(s) adapté(s).
// Modèle : Haiku (rapide, économique). Réponse JSON stricte, contrainte à la
// liste des métiers actifs en base — l'IA ne peut pas inventer un métier.
// Appelée AVANT authentification (écran 2 du parcours) : garde-fous de taille
// et de coût intégrés. Env : ANTHROPIC_API_KEY.
const { admin, json } = require('./_lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON invalide' }); }
  const description = String(body.description || '').trim().slice(0, 500); // garde-fou coût
  if (description.length < 8) return json(400, { error: 'Description trop courte' });

  const { data: trades } = await admin
    .from('trades').select('id, label_fr').eq('is_active', true);
  if (!trades?.length) return json(500, { error: 'Référentiel métiers indisponible' });

  const tradeList = trades.map((t) => `${t.id} = ${t.label_fr}`).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        system:
          `Tu aides une plateforme de dépannage à domicile à Douala (Cameroun). ` +
          `À partir de la description d'un problème par un client, tu réponds UNIQUEMENT ` +
          `avec un JSON valide, sans backticks ni texte autour, au format : ` +
          `{"reformulation": "...", "trades": ["id1", "id2"]}. ` +
          `"reformulation" : une phrase claire et rassurante qui reformule le problème et le type d'intervention recommandé, en français simple. ` +
          `"trades" : 1 à 3 identifiants choisis EXCLUSIVEMENT dans cette liste (le plus probable en premier) :\n${tradeList}\n` +
          `Si la description ne correspond à aucun métier de la liste, renvoie "trades": [].`,
        messages: [{ role: 'user', content: description }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // Validation stricte côté serveur : jamais de métier hors référentiel
    const validIds = new Set(trades.map((t) => t.id));
    const suggested = (Array.isArray(parsed.trades) ? parsed.trades : [])
      .filter((id) => validIds.has(id)).slice(0, 3);

    return json(200, {
      reformulation: String(parsed.reformulation || '').slice(0, 300),
      trades: suggested,
    });
  } catch (e) {
    console.error('suggest-trade error', e.message);
    // Échec IA = jamais bloquant : le front bascule en choix manuel
    return json(200, { reformulation: null, trades: [] });
  }
};
