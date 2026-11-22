// The app's entry to the shared receipt model. The model lives with the edge functions so the PDF sent
// on WhatsApp and the receipt on screen are built by the same code.
export * from "../../supabase/functions/_shared/receipt-model.ts";
