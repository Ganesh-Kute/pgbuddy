import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createCreateSubscriptionHandler } from "./handler.ts";

Deno.serve(createCreateSubscriptionHandler({ createClient }));
