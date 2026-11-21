import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createTwilioNotificationsHandler } from "./handler.ts";

Deno.serve(createTwilioNotificationsHandler({ createClient }));
