// api/shopify-webhook.js
// Serverless endpoint for Vercel: receives Shopify webhooks and forwards purchases to GA4 MP

import crypto from "crypto";

const MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID; // e.g., G-XXXXXXXXXX
const API_SECRET = process.env.GA4_API_SECRET;         // GA4 Measurement Protocol API secret
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || ""; // optional

const GA4_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;
const GA4_DEBUG   = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;

// Helper: verify Shopify HMAC (recommended)
function verifyShopifyHmac(req, rawBody) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // if you didn't set it, skip verification
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(digest));
}

// Helper: safe number
const toNumber = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  api: {
    bodyParser: false, // we need raw body for HMAC verification
  },
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Read raw body for HMAC
    const rawBody = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    // Verify HMAC (optional)
    if (!verifyShopifyHmac(req, rawBody)) {
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }

    const order = JSON.parse(rawBody);

    // ---- Map Shopify order -> GA4 purchase event ----
    const attributes = order?.note_attributes || [];
    const getAttr = (key) =>
      attributes.find((a) => a.name?.toLowerCase() === key.toLowerCase())?.value;

    const clientId =
      getAttr("client_id") ||
      getAttr("_ga_cid") ||
      (order.customer?.id ? String(order.customer.id) : String(order.id));

    const userId = order?.customer?.email || null;

    const gclid = getAttr("gclid") || null;
    const gbraid = getAttr("gbraid") || null;
    const wbraid = getAttr("wbraid") || null;
    const utm_source = getAttr("utm_source") || null;
    const utm_medium = getAttr("utm_medium") || null;
    const utm_campaign = getAttr("utm_campaign") || null;
    const utm_content = getAttr("utm_content") || null;
    const utm_term = getAttr("utm_term") || null;

    const items =
      (order.line_items || []).map((item) => ({
        item_id: String(item.product_id || item.sku || item.variant_id || item.id),
        item_name: item.title || item.name,
        quantity: item.quantity || 1,
        price: toNumber(item.price || item.price_set?.shop_money?.amount || 0),
        item_brand: order?.line_items?.vendor || undefined,
        item_variant: item.variant_title || undefined,
      })) || [];

    const ga4Event = {
      client_id: String(clientId),
      ...(userId ? { user_id: userId } : {}),
      non_personalized_ads: false,
      events: [
        {
          name: "purchase",
          params: {
            transaction_id: String(order.id),
            value: toNumber(order.total_price || order.current_total_price || order.total_price_set?.shop_money?.amount),
            currency: order.currency || order.presentment_currency || "INR",
            tax: toNumber(order.total_tax || 0),
            shipping: toNumber(order.total_shipping_price_set?.shop_money?.amount || 0),
            coupon: order.discount_codes?.[0]?.code || undefined,
            items,
            ...(gclid ? { gclid } : {}),
            ...(gbraid ? { gbraid } : {}),
            ...(wbraid ? { wbraid } : {}),
            ...(utm_source ? { utm_source } : {}),
            ...(utm_medium ? { utm_medium } : {}),
            ...(utm_campaign ? { utm_campaign } : {}),
            ...(utm_content ? { utm_content } : {}),
            ...(utm_term ? { utm_term } : {}),
          },
        },
      ],
    };

    const endpoint = process.env.GA4_DEBUG_MODE === "1" ? GA4_DEBUG : GA4_ENDPOINT;

    const gaRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ga4Event),
    });

    const text = await gaRes.text();

    return res.status(200).json({
      status: "ok",
      sent_to: endpoint.includes("/debug/") ? "GA4 DEBUG" : "GA4",
      ga_response: text,
    });
  } catch (e) {
    console.error("ERROR:", e);
    return res.status(500).json({ error: "Internal error" });
  }
}
