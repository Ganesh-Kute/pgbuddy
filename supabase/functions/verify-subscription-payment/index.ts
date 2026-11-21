import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createVerifySubscriptionHandler } from "./handler.ts";

Deno.serve(createVerifySubscriptionHandler({ createClient }));
