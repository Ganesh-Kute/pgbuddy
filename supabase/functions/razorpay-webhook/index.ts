import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRazorpayWebhookHandler } from "./handler.ts";

Deno.serve(createRazorpayWebhookHandler({ createClient }));
