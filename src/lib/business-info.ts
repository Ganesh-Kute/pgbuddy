// The registered business behind PG Buddy, exactly as on the Udyam Registration Certificate.
// Meta Business Verification compares the website with that certificate, so the name and registration
// number here must stay identical to it. Full street address deliberately not shown (residential).
export const BUSINESS = {
  legalName: "PG BUDDY",
  udyamNumber: "UDYAM-MH-33-0750176",
  locality: "Dombivli, Thane, Maharashtra 421204, India",
  whatsappDisplay: "+91 95455 54067",
  whatsappE164: "919545554067",
} as const;

export const whatsappLink = `https://wa.me/${BUSINESS.whatsappE164}`;
