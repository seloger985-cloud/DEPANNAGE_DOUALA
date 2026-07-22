// GET /api/generate-invoice?mission_id=...
// Génère la facture PDF d'une mission payée, à la volée (aucun stockage).
// Accessible par le client OU l'artisan de la mission (versions identiques v1).
// Pattern : rendu natif jsPDF (text + splitTextToSize) — jamais html2canvas.
// Dépendance : "jspdf" dans package.json.
const { jsPDF } = require('jspdf');
const { admin, getUserFromRequest, json } = require('./_lib/supabase');

// ⚠️ Placeholders à remplacer quand le nom/la structure juridique sont actés
const BRAND = {
  name: 'PLATEFORME DÉPANNAGE',        // ← nom du produit
  legal: 'Raison sociale — Douala, Cameroun',
  rccm: 'RCCM : —',
  niu: 'NIU : —',
  phone: 'WhatsApp : —',
};

const fcfa = (n) => (n ?? 0).toLocaleString('fr-FR') + ' FCFA';

exports.handler = async (event) => {
  const user = await getUserFromRequest(event);
  if (!user) return json(401, { error: 'Non authentifié' });

  const missionId = event.queryStringParameters?.mission_id;
  if (!missionId) return json(400, { error: 'mission_id requis' });

  const { data: m } = await admin.from('missions').select('*').eq('id', missionId).single();
  if (!m) return json(404, { error: 'Mission introuvable' });
  if (m.client_id !== user.id && m.assigned_artisan !== user.id)
    return json(403, { error: 'Accès réservé aux parties de la mission' });
  if (!['paid', 'closed'].includes(m.status))
    return json(409, { error: 'La facture est disponible après paiement complet' });

  const [{ data: client }, { data: artisan }, { data: trade }, { data: quote }, { data: payments }] =
    await Promise.all([
      admin.from('profiles').select('full_name, phone').eq('id', m.client_id).single(),
      admin.from('profiles').select('full_name, phone').eq('id', m.assigned_artisan).single(),
      admin.from('trades').select('label_fr').eq('id', m.trade_id).single(),
      admin.from('quotes').select('amount_fcfa, details, decided_at')
        .eq('mission_id', m.id).eq('status', 'accepted')
        .order('decided_at', { ascending: false }).limit(1).maybeSingle(),
      admin.from('payments').select('kind, amount_fcfa, settled_at')
        .eq('mission_id', m.id).eq('status', 'successful'),
    ]);

  const invoiceNo = `FAC-${new Date(m.created_at).getFullYear()}-${m.id.slice(0, 8).toUpperCase()}`;
  const totalPaid = (payments || []).reduce((s, p) => s + p.amount_fcfa, 0);

  // ================= PDF =================
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, MARGIN = 18, CONTENT = W - MARGIN * 2;
  let y = 20;

  const text = (str, x, opts = {}) => {
    pdf.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    pdf.setFontSize(opts.size || 10);
    pdf.setTextColor(...(opts.color || [20, 27, 35]));
    const lines = pdf.splitTextToSize(String(str), opts.width || CONTENT);
    pdf.text(lines, x, y, { align: opts.align || 'left' });
    y += lines.length * (opts.lh || (opts.size || 10) * 0.45) + (opts.gap ?? 2);
  };
  const hr = () => { pdf.setDrawColor(228, 224, 214); pdf.line(MARGIN, y, W - MARGIN, y); y += 6; };

  // En-tête
  pdf.setFillColor(20, 27, 35);
  pdf.rect(0, 0, W, 34, 'F');
  pdf.setTextColor(255, 177, 0);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(16);
  pdf.text(BRAND.name, MARGIN, 15);
  pdf.setTextColor(185, 192, 201); pdf.setFontSize(8); pdf.setFont('helvetica', 'normal');
  pdf.text(`${BRAND.legal}  ·  ${BRAND.rccm}  ·  ${BRAND.niu}  ·  ${BRAND.phone}`, MARGIN, 22);
  pdf.setTextColor(255, 255, 255); pdf.setFontSize(12); pdf.setFont('helvetica', 'bold');
  pdf.text('FACTURE', W - MARGIN, 15, { align: 'right' });
  pdf.setFontSize(9); pdf.setFont('helvetica', 'normal');
  pdf.text(invoiceNo, W - MARGIN, 21, { align: 'right' });
  pdf.text(new Date().toLocaleDateString('fr-FR'), W - MARGIN, 26, { align: 'right' });

  y = 46;
  // Parties
  text('CLIENT', MARGIN, { size: 8, bold: true, color: [90, 100, 114], gap: 1 });
  text(`${client.full_name} · ${client.phone}`, MARGIN, { size: 10, gap: 5 });
  text('ARTISAN INTERVENANT', MARGIN, { size: 8, bold: true, color: [90, 100, 114], gap: 1 });
  text(`${artisan.full_name} · ${trade.label_fr}`, MARGIN, { size: 10, gap: 6 });
  hr();

  // Intervention
  text('INTERVENTION', MARGIN, { size: 8, bold: true, color: [90, 100, 114], gap: 1 });
  text(m.description, MARGIN, { size: 10, gap: 3 });
  if (quote?.details) text(`Travaux réalisés : ${quote.details}`, MARGIN, { size: 9, color: [90, 100, 114], gap: 6 });
  hr();

  // Lignes de facturation
  const line = (label, amount, bold = false) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal');
    pdf.setFontSize(bold ? 11 : 10);
    pdf.setTextColor(20, 27, 35);
    pdf.text(label, MARGIN, y);
    pdf.text(fcfa(amount), W - MARGIN, y, { align: 'right' });
    y += bold ? 8 : 7;
  };
  line('Forfait déplacement & diagnostic', m.diagnostic_fee_fcfa);
  if (quote) line('Prestation (devis accepté dans l’application)', quote.amount_fcfa);
  y += 2; hr();
  pdf.setFillColor(255, 251, 240);
  pdf.rect(MARGIN, y - 4, CONTENT, 12, 'F');
  line('TOTAL PAYÉ (Mobile Money)', totalPaid, true);
  y += 6;

  // Garantie + mentions
  pdf.setFillColor(20, 27, 35);
  pdf.roundedRect(MARGIN, y, CONTENT, 16, 2, 2, 'F');
  pdf.setTextColor(255, 177, 0); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9);
  pdf.text('GARANTIE 7 JOURS', MARGIN + 5, y + 6);
  pdf.setTextColor(255, 255, 255); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8);
  pdf.text('Si le problème réparé réapparaît sous 7 jours calendaires, l’artisan revient sans frais. Contactez notre support.', MARGIN + 5, y + 11, { maxWidth: CONTENT - 10 });
  y += 24;

  text(`Paiement intégral reçu via Mobile Money. Mission n° ${m.id}.`, MARGIN, { size: 8, color: [90, 100, 114], gap: 1 });
  text('Cette facture est générée automatiquement par la plateforme, qui agit comme intermédiaire de mise en relation.', MARGIN, { size: 8, color: [90, 100, 114] });

  // Sortie base64
  const b64 = Buffer.from(pdf.output('arraybuffer')).toString('base64');
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${invoiceNo}.pdf"`,
    },
    body: b64,
    isBase64Encoded: true,
  };
};
