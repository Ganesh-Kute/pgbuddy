// Create the WhatsApp templates in supabase/functions/_shared/whatsapp-templates.ts on Meta.
//
//   WHATSAPP_TOKEN=... npx -y tsx scripts/create-whatsapp-templates.ts
//   npx -y tsx scripts/create-whatsapp-templates.ts --dry-run    (prints the request bodies only)
//
// Templates that already exist on the WhatsApp Business Account are skipped, so it is safe to run
// again. Meta reviews new UTILITY templates, usually within minutes to a few hours.

import { GRAPH_VERSION } from "../supabase/functions/_shared/whatsapp-cloud.ts";
import { TEMPLATES, templateCreatePayload } from "../supabase/functions/_shared/whatsapp-templates.ts";

const WABA_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? "1920091279356235";
const token = process.env.WHATSAPP_TOKEN;
const dryRun = process.argv.includes("--dry-run");
const graph = `https://graph.facebook.com/${GRAPH_VERSION}/${WABA_ID}/message_templates`;
const headers: Record<string, string> = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };

async function main() {
  if (dryRun) {
    // Print the request bodies without calling Meta.
    for (const def of Object.values(TEMPLATES)) console.log(JSON.stringify(templateCreatePayload(def)));
    return;
  }
  const listed = await fetch(`${graph}?fields=name,status&limit=200`, { headers });
  const list = (await listed.json()) as { data?: { name: string; status: string }[]; error?: { message: string } };
  if (!list.data) throw new Error(`Could not list templates: ${list.error?.message ?? listed.status}`);
  const existing = new Map(list.data.map((t) => [t.name, t.status]));

  for (const def of Object.values(TEMPLATES)) {
    if (existing.has(def.name)) {
      console.log(`= ${def.name}: already ${existing.get(def.name)}`);
      continue;
    }
    const resp = await fetch(graph, { method: "POST", headers, body: JSON.stringify(templateCreatePayload(def)) });
    const out = (await resp.json()) as { id?: string; status?: string; category?: string; error?: { message: string; error_user_msg?: string } };
    console.log(
      out.id
        ? `+ ${def.name}: ${out.status} (${out.category})`
        : `! ${def.name}: ${out.error?.error_user_msg ?? out.error?.message ?? resp.status}`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
