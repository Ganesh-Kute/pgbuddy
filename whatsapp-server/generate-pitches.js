/**
 * 🤖 LLM Pitch Generator — Groq Edition
 * Reads pg_leads.json, generates hyper-personalized WhatsApp pitches using Groq (llama-3.3-70b)
 * and pushes them into the Supabase whatsapp_message_queue.
 *
 * Usage: node generate-pitches.js
 *        node generate-pitches.js --dry-run    (preview only, don't queue)
 */

try { require("dotenv").config(); } catch { /* dotenv optional if env is already set */ }
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// ── Config ──
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY_RUN = process.argv.includes("--dry-run");

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY environment variable is required.");
  process.exit(1);
}
if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_KEY)) {
  console.error("❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required unless --dry-run is passed.");
  process.exit(1);
}

const LEADS_FILE = path.join(__dirname, "pg_leads.json");
const OUTPUT_FILE = path.join(__dirname, "pg_pitches.json");

const SYSTEM_PROMPT = `You are an elite B2B sales copywriter for PG Buddy. I will give you JSON data for a Paying Guest (PG) business in Pune.

Write a high-end, professionally formatted WhatsApp message to the owner. It should look like a premium tech service, not cheap promotion.

Rules:
- Format the message with bold text (*text*), professional emojis (🏠, ✅, 📉), and clear line breaks.
- Sentence 1: Start with "🏠 *[PG Name]*" on its own line. Then state you noticed their Google rating (and specific pain point if available).
- Middle Section: List out PG Buddy's key features vertically with checkmarks:
  ✅ *Automated WhatsApp Reminders*
  ✅ *Digital Receipts & Billing*
  ✅ *Complaint Tracking*
  ✅ *Mess & Room Analytics*
- Sentence 3: Mention that local Pune PGs use this to stop manual follow-ups and increase collections by 20%.
- Sentence 4: Add the website link: "Check out: https://pgbuddy-zeta-rust.vercel.app"
- Sentence 5: Close with: "We can discuss everything in person—when are you available for a quick 5-min meet?"

Tone: Professional, expert, and results-oriented. Make it look clean and structured. No salesy fluff. Strictly 5 sections/sentences.`;

// ── Helpers ──
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function callGroq(leadJson) {
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(leadJson) },
      ],
      temperature: 0.7,
      max_tokens: 200,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function main() {
  console.log(`\n🤖 PG Buddy — LLM Pitch Generator\n`);
  console.log(`   Model: ${GROQ_MODEL} via Groq`);
  console.log(`   Mode:  ${DRY_RUN ? "DRY RUN (preview only)" : "LIVE (will queue messages)"}\n`);

  // Load leads
  if (!fs.existsSync(LEADS_FILE)) {
    console.error(`❌ ${LEADS_FILE} not found. Run scrape-leads.js first.`);
    process.exit(1);
  }

  const leads = JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8"));
  console.log(`📋 Loaded ${leads.length} leads from pg_leads.json\n`);

  if (leads.length === 0) {
    console.log("⚠️  No leads to process. Exiting.");
    return;
  }

  const supabase = DRY_RUN ? null : createClient(SUPABASE_URL, SUPABASE_KEY);
  const pitches = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    console.log(`[${i + 1}/${leads.length}] Generating pitch for "${lead.pg_name}"...`);

    try {
      const pitch = await callGroq({
        pg_name: lead.pg_name,
        rating: lead.rating || "No rating",
        review_count: lead.review_count || 0,
        bad_review_text: lead.bad_review_text || "No reviews available",
        address: lead.address || "Pune",
      });

      console.log(`   ✅ "${pitch.substring(0, 80)}..."\n`);

      pitches.push({
        phone: lead.phone,
        pg_name: lead.pg_name,
        pitch_message: pitch,
        rating: lead.rating,
        review_count: lead.review_count,
      });

      // Rate limit: Groq free tier = 30 RPM → ~2s between calls
      await delay(2500);

    } catch (err) {
      console.log(`   ❌ Failed: ${err.message}\n`);
    }
  }

  // Save pitches to file
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(pitches, null, 2));
  console.log(`\n💾 Saved ${pitches.length} pitches to ${OUTPUT_FILE}`);

  // Queue in Supabase
  if (!DRY_RUN && pitches.length > 0) {
    console.log(`\n📤 Queueing ${pitches.length} messages in Supabase...`);

    const rows = pitches.map((p) => ({
      phone_number: `91${p.phone}`,
      message: p.pitch_message,
      template_type: "b2b_pitch",
      status: "pending",
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from("whatsapp_message_queue").insert(rows);
    if (error) {
      console.error(`❌ Database error: ${error.message}`);
    } else {
      console.log(`✅ ${pitches.length} pitches queued! They will be sent every 3 minutes.`);
    }
  } else if (DRY_RUN) {
    console.log(`\n🏁 DRY RUN complete. Review pg_pitches.json, then run without --dry-run to queue.`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Summary: ${pitches.length}/${leads.length} pitches generated`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(err => {
  console.error("❌ Pitch generator crashed:", err.message);
  process.exit(1);
});
