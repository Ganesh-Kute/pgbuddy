import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createGetReceiptHandler } from "./handler.ts";

Deno.serve(createGetReceiptHandler({ createClient }));
