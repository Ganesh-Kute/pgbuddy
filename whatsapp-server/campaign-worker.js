/**
 * 📨 PG Buddy — Campaign Worker
 * Runs in a separate terminal to handle the 3rd-minute drip marketing outreach.
 * Communicates with the Master Server to send messages.
 */

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
require("dotenv").config();

const COMPROMISED_DEFAULT_SECRET = ["pg_buddy", "whatsapp", "secret", "2024"].join("_");

function validateWorkerConfig(env = process.env) {
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const supabaseKey = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string" ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : "";
  const serverSecret = typeof env.SERVER_SECRET === "string" ? env.SERVER_SECRET.trim() : "";

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY credentials in environment.");
  }
  if (!serverSecret) {
    throw new Error("Missing SERVER_SECRET environment variable. Refusing to start without a configured secret.");
  }
  if (serverSecret === COMPROMISED_DEFAULT_SECRET) {
    throw new Error("SERVER_SECRET must not use the leaked example placeholder. Set a unique secret.");
  }

  return {
    supabaseUrl,
    supabaseKey,
    serverSecret,
    masterServerUrl: env.MASTER_SERVER_URL || `http://localhost:${env.PORT || 3001}`,
  };
}

const CAMPAIGN_INTERVAL = 3 * 60 * 1000;

function startWorker() {
  let config;
  try {
    config = validateWorkerConfig(process.env);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseKey);

  async function processCampaign() {
    console.log(`\n🔍 [${new Date().toLocaleTimeString()}] Checking for pending pitches...`);

    try {
      const { data: rows, error } = await supabase
        .from("whatsapp_message_queue")
        .select("*")
        .eq("status", "pending")
        .eq("template_type", "b2b_pitch")
        .order("created_at", { ascending: true })
        .limit(1);

      if (error) throw error;
      if (!rows || rows.length === 0) {
        console.log("😴 No pending pitches found. Sleeping...");
        return;
      }

      const row = rows[0];
      const cleanPhone = String(row.phone_number || "").replace(/\D/g, "");

      const imagePaths = [];
      const videoPaths = [];
      const files = fs.readdirSync("./");

      files.forEach((file) => {
        if (file.match(/^campaign.*\.(png|jpg|jpeg)$/i)) {
          imagePaths.push(`./${file}`);
        } else if (file.match(/^campaign.*\.(mp4|mov|avi|mkv)$/i)) {
          videoPaths.push(`./${file}`);
        }
      });

      try {
        const payload = {
          phoneNumber: cleanPhone,
          message: row.message,
          isCampaign: true,
        };

        if (videoPaths.length > 0) {
          payload.videoPath = videoPaths.sort()[0];
        } else if (imagePaths.length > 0) {
          payload.imagePaths = imagePaths.sort();
        }

        const resp = await axios.post(`${config.masterServerUrl}/api/send-instant`, payload, {
          headers: {
            "x-server-secret": config.serverSecret,
            Authorization: `Bearer ${config.serverSecret}`,
          },
        });

        if (resp.data?.success) {
          await supabase
            .from("whatsapp_message_queue")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", row.id);

          console.log("✅ Success: Message sent via Master Server.");
        }
      } catch (apiErr) {
        const errorMsg = apiErr.response?.data?.error || apiErr.message;
        console.error(`❌ Master Server rejected send: ${errorMsg}`);

        if (apiErr.response?.status === 404) {
          await supabase
            .from("whatsapp_message_queue")
            .update({ status: "failed", error: "not_on_whatsapp", sent_at: new Date().toISOString() })
            .eq("id", row.id);
        }
      }
    } catch (e) {
      console.error("❌ Worker error:", e.message);
    }
  }

  console.log("==========================================");
  console.log("🚀 PG Buddy Campaign Worker Started");
  console.log("⏰ Interval: 3 Minutes");
  console.log(`🔗 Master: ${config.masterServerUrl}`);
  console.log("==========================================\n");

  processCampaign();
  setInterval(processCampaign, CAMPAIGN_INTERVAL);
}

if (require.main === module) {
  startWorker();
}

module.exports = {
  validateWorkerConfig,
  startWorker,
};
