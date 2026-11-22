import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createSendSmsOtpHandler } from "./handler.ts";

Deno.serve(createSendSmsOtpHandler());
