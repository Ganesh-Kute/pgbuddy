import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as pdfLib from "npm:pdf-lib@1.17.1";
import { createTwilioNotificationsHandler } from "./handler.ts";

Deno.serve(createTwilioNotificationsHandler({ createClient, pdfLib }));
